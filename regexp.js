/**
 * Regexp message handler
 * @version 1.0.3
 * @author 0LEG0 <a.i.s@gmx.com>
 * 
 * Regexp command line:
 * [command args][;params=values]=[target]
 * command: if | return | echo | enqueue
 * by default every command line begins with "if" and ends with "return"
 * 
 * Example
 * if ${param}regexp=return true;param1=\1
 * ${param}.*=echo ${text}
 * ${param1}true=if ${param2}true=echo Yes We got it!;return true
 * .*=echo Message ${param} 
 */
"use strict";

const { JMessage, connect } = require("jms-engine");
const { v4: uuid } = require("uuid");
const { format } = require("fecha");
const fs = require("fs");
const querystring = require("querystring");
const JENGINE = connect({trackname: "regexp", selfdispatch: false});
const CONFIGFILE = process.env.JMS_PATH + "/conf/regexp.conf";
let CONFIG = { install: [] };
const CONTEXTS = new Map(); // message.name, context.function

// -- regexp.conf --
// [section]
const REGEXP_CONTEXT = /^\s*\[(?<name>[a-zA-Z0-9._]+)\]/;
// ; or # comment
const REGEXP_SKIP = /^\s*[;#]|^$/
// messageName=[priority][,context]
const REGEXP_INSTALL = /^\s*(?<message>[a-zA-Z0-9._]+)=\s*(?<priority>\d+)?(\s*[,]\s*)?(?<context>\w[a-zA-Z0-9.]*)?$/;
// --
// line function parser
const REGEXP_FUNCTION = /^=?(?<func>(random|uuid|date))[ ,]*=?(?<params>.+)?$/
// command line parser
//const REGEXP_COMMAND = /^\s*=?(?<command>(if|echo|return|enqueue|call|jump)(?=\s+|;))?[\s]?(?<args>[^;=]+)?(?<params>(;[^;=]+=[^;=]*)+)?(?<target>=.*?)?$/;
const REGEXP_COMMAND = /^\s*=?(?<command>(if|echo|return|enqueue|call|jump)(?=\s+|;))?[\s]?(?<args>[^;=]+)?(?<params>(;[^;=]+=?[^;=]*)+)?(?<target>=.*?)?$/;
// if expression: ${param}regexp.*
const REGEXP_IF = /^\s*(?<source>\$\{[0-9a-zA-Z._]+\})?(?<regex>.*)$/;
// JS types parser
const REGEXP_NUMBER = /^\d*\.?\d+$/;
const REGEXP_TRUE = /^true$/;
const REGEXP_FALSE = /^false$/;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// parses command line
function parseCommand(line = "") {
	return REGEXP_COMMAND.exec(line)?.groups ?? {
			command: undefined,
			args: undefined,
			params: undefined,
			target: undefined,
		};
}

function parseType(value) {
	switch (true) {
	case REGEXP_NUMBER.test(value): return Number(value);
	case REGEXP_TRUE.test(value): return true;
	case REGEXP_FALSE.test(value): return false;
	default: return value;
	}
}

// Regexp commands:
const COMMAND = {
	"if": function(message, args = "", params, target = "") {
		// console.log("If:", args);
		let { source, regex } = REGEXP_IF.exec(args)?.groups ?? { source: "", regex: "" };
		source = replaceParam(message, source);
		//target = replaceParam(message, target);
		return replaceRegexp(regex, source, target);
	},
	"return": function(message, args = "", params = "", target) {
		// console.log("Return:", args, params);
		args = replaceParam(message, args);
		params = parseParams(replaceParam(message, params));
		for (let key in params) message.set(key, parseType(params[key]));
		if (args) {
			message.result = parseType(args.trim());
			message.handled = true;
		}
		return message;
	},
	"echo": function(message, args = "", params = "", target) {
		args = replaceParam(message, args);
		params = replaceParam(message, params);
		target = replaceParam(message, target);
		// console.log("Echo:", args, params);
		JENGINE.raw(args + params);
		return target;
	},
	"enqueue": function(message, args = "", params = "", target) {
		// console.log("Enqueue:", args, params, target);
		try {
			args = replaceParam(message, args);
			params = parseParams(replaceParam(message, params));
			target = replaceParam(message, target);
			let msg = new JMessage(args, {}, true);
			for (let key in params) msg.set(key, parseType(params[key]));
			JENGINE.enqueue(msg);
		} catch (err) {
			JENGINE.error("regexp enqueue", err.stack);
			// console.error(err.stack);
		}
		return target;
	},
	// todo
	"dispatch": function(message, args = "", params = "", target) {
		// console.log("Enqueue:", args, params);
		return target;
	}
}

const FUNC = {
	"random": function(...template) {
		//console.log("Template is:", template);
		return template.join(" ").split("").map(char => {
			switch(char) {
				case "*": return CHARACTERS.charAt(Math.floor(Math.random() * CHARACTERS.length));
				case "@": return LETTERS.charAt(Math.floor(Math.random() * LETTERS.length));
				case "#": return Math.floor(Math.random() * 10);
				default: return char;
			}
		}).join("");
	},
	"uuid": () => uuid(),
	"date": function(template) {
		return format(new Date(), template);
	}
}

// Executes command line
function executeCommand(message, line = "") {
	// console.log("Execute:", line);
	let c = parseCommand(line);
	// console.log(c);
	if (c.command == "call") {
		let ctx = CONTEXTS.get(c.args);
		if (typeof ctx == "function") return ctx(message);
		return message;
	}
	if (c.command == "jump") {
		let ctx = CONTEXTS.get(c.args);
		if (typeof ctx == "function") {
			let res = ctx(message);
			res.return = true;
			return res;
		}
		return message;
	}
	if (c.command == "return") {
		message.return = true;
		return COMMAND["return"](message, c.args, c.params, c.target);
	}
	if (!COMMAND[c.command]) return COMMAND["return"](message, c.args, c.params, c.target);
	return executeCommand(message, COMMAND[c.command](message, c.args, c.params, c.target));	
}

// parse coma-separated params: param1=value1;param2=value2
function parseParams(line = "") {
	return querystring.parse(line, ";");
}

// replaces message ${params} with its values in the line
function replaceParam(message, template = "") {
	if (!(message instanceof JMessage)) return template;
	let result = "";
	let param = "";
	for (let i = 0; i < template.length; i++) {
		if (template[i] == "$" && template[i + 1] == "{") {
			i += 2;
			for (; i < template.length; i++) {
				if (template[i] == "}") {
					i++;
					break;
				}
				param += template[i];
			}
			if (param.length > 0) {
				//result += param;
				result += message.get(param);
				param = "";
			}
		}
		if (template[i] == "$" && template[i + 1] == "(") {
			i += 2;
			for (; i < template.length; i++) {
				if (template[i] == ")") {
					i++;
					break;
				}
				param += template[i];
			}
			if (param.length > 0) {
				//result += func(param);
				let { func = "", params = "" } = REGEXP_FUNCTION.exec(param)?.groups ?? {};

				if (!FUNC[func]) {
					result += param;
				} else {
					result += FUNC[func](...params.split(",").map(item => item.trim()));
				}
				param = "";
			}
		}
		if (i < template.length) result += template[i];
	}
	return result;
}

// replaces \0..\n regexp groups with its values in the line 
function replaceRegexp(regexp = "", source = "", template = "") {
	if (typeof regexp == "string") regexp = new RegExp(regexp);
	let found = regexp.exec(source);
	if (!found) return "";
	let result = "";
	for (let i = 0; i < template.length; i++) {
		if (template.charCodeAt(i) == 92) {// "\"
			let num = "";
			i++;
			for (; i < template.length; i++) {
				if (
					template.charCodeAt(i) > 47 &&
					template.charCodeAt(i) < 58
				) {
					num += template[i];
				} else {
                    i--;
					break;
				}
			}
			if (num.length > 0) {
				let group = Number.parseInt(num);
				if (found[group]) result += found[group];
			} else {
				result += "\\";
			}
		} else {
			result += template[i];
		}
	}
	return result;
}

// parse regexp line into function
function createHandler(line) {
	// parse line
	if (typeof line !== "string") return;
	let c = parseCommand(line);
	if (!c.command) c.command = "if";	
	return function(message) {
		if (!(message instanceof JMessage)) return;
		return executeCommand(message, COMMAND[c.command](message, c.args, c.params, c.target));
	}
}

// create context handler
function createContext(arr) {
	if (!(arr instanceof Array)) return;
	let handlers = [];
	for (let line of arr) {
		let handler = createHandler(line);
		if (typeof handler == "function") handlers.push(handler);
	}
	return function(message) {
		if (!(message instanceof JMessage)) return;
		// console.log("Context handler(", message.name, ")");
		let res = message;
		for (let handler of handlers) {
			res = handler(res); // <- res or message
			if (res.handled == true || res.return) { // <- res instanceof JMessage
				res.return = undefined;
				return res;
			}
		}
		return res;
	}
}

function unload() {
	if (!CONFIG.install) return Promise.resolve();
	return new Promise((resolve, reject) => {
		for (let i = 0; i < CONFIG.install.length; i++) {
			let {message, priority, context} = REGEXP_INSTALL.exec(CONFIG.install[i])?.groups ?? {};
			if (message && CONTEXTS.has(context ?? message)) {
				JENGINE.note("Regexp:", message, "message has been uninstalled from context", context ?? message);
				JENGINE.uninstall(message);
			}
		}
		CONTEXTS.clear();
		resolve();
	});
}

function load(file = "regexp.conf") {
	return unload().then(() => {
	// read file to config obj
	let raw = fs.readFileSync(file, "utf-8");
	CONFIG = { install: [] };
	let section;
	raw.split("\n").forEach((line) => {
		if (REGEXP_CONTEXT.test(line)) {
			// create section
			section = REGEXP_CONTEXT.exec(line).groups.name;
			CONFIG[section] = [];
		} else if (!REGEXP_SKIP.test(line)) {
			// create expression
			CONFIG[section].push(line);
			// console.log(line, regexInstall.exec(line)?.groups);
		}
	});

	// create contexts
	for (let ctx in CONFIG) {
		if (ctx !== "install") {
			// console.log("Create context:", ctx);
			CONTEXTS.set(ctx, createContext(CONFIG[ctx]));
		}
	}
	// subscribe to contexts
	if (CONFIG.install) CONFIG.install.forEach(line => {
		let {message, priority = "100", context} = REGEXP_INSTALL.exec(line)?.groups ?? {};
		if (message && CONTEXTS.has(context ?? message)) {
			JENGINE.note("Regexp", message, "message has been installed to context", context ?? message);
			JENGINE.install(message, CONTEXTS.get(context ?? message), parseInt(priority));
		}
	});

	return CONFIG;
	});
}

async function onCommand(message) {
	if (typeof message.get("line") !== "string" || message.get("line") !== "regexp reload") return;
	message.handled = true;
	message.result = "loading " + CONFIGFILE;
	try {
		await load(CONFIGFILE);
	} catch (err) {
		message.error = err.stack;
		JENGINE.error(message.error);
		return message;
	}
}

async function onHalt() {
	await unload();
	process.exit(0);
}

async function main() {
	load(CONFIGFILE);
	JENGINE.install("jengine.command", onCommand);
	JENGINE.install("jengine.halt", onHalt);
	JENGINE.note("Regexp module started.");
}

main().catch(JENGINE.error);
