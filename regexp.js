/**
 * Regexp message handler
 * @version 1.0.0
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
const CONFIGFILE = process.env.PWD + "/conf/.jms-regexp.conf";
let config = { install: [] };
const contexts = new Map(); // message.name, context.function

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
		let ctx = contexts.get(c.args);
		if (typeof ctx == "function") return ctx(message);
		return message;
	}
	if (c.command == "jump") {
		let ctx = contexts.get(c.args);
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
	if (!config.install) return Promise.resolve();
	return new Promise((resolve, reject) => {
		for (let i = 0; i < config.install.length; i++) {
			let {message, priority, context} = REGEXP_INSTALL.exec(config.install[i])?.groups ?? {};
			if (message && contexts.has(context ?? message)) {
				JENGINE.info("Regexp:", message, "message has been uninstalled from context", context ?? message);
				JENGINE.uninstall(message);
			}
		}
		contexts.clear();
		resolve();
	});
}

function load(file = ".jms-regexp.conf") {
	return unload().then(() => {
	// read file to config obj
	let raw = fs.readFileSync(file, "utf-8");
	config = { install: [] };
	let section;
	raw.split("\n").forEach((line) => {
		if (REGEXP_CONTEXT.test(line)) {
			// create section
			section = REGEXP_CONTEXT.exec(line).groups.name;
			config[section] = [];
		} else if (!REGEXP_SKIP.test(line)) {
			// create expression
			config[section].push(line);
			// console.log(line, regexInstall.exec(line)?.groups);
		}
	});

	// create contexts
	for (let ctx in config) {
		if (ctx !== "install") {
			// console.log("Create context:", ctx);
			contexts.set(ctx, createContext(config[ctx]));
		}
	}
	// subscribe to contexts
	if (config.install) config.install.forEach(line => {
		let {message, priority = 100, context} = REGEXP_INSTALL.exec(line)?.groups ?? {};
		if (message && contexts.has(context ?? message)) {
			JENGINE.info("Regexp", message, "message has been installed to context", context ?? message);
			JENGINE.install(message, contexts.get(context ?? message), priority);
		}
	});

	return config;
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
	return unload().then(() => {
		process.exit(0);
	})
}

// async function test() {
	// console.log("Test replaceRegexp:", replaceRegexp("(\\w+)\\s+(\\w+)", "Hello World!", "echo \\1;marked=\\2;handled=ext\\.\\d+"));
	// console.log("Test replaceParam:", replaceParam(new JMessage("test", {param1: "Value1"}), "Here is param1 = ${param1}"));
	// console.log("Test parseCommand:", parseCommand(" =return;first=Hello;second=World;handled=true"));
	// console.log("Test parseParams:", parseParams("marked=No;handled=true"));
	// console.log("Test replaceFunction:", replaceParam(new JMessage("test", {param1: "VALUEZ"}), "${param1}, $(random , this # is number and this @ is letter)"));
	// console.log("Test replaceFunction:", replaceParam(new JMessage("test", {param1: "VALUEZ"}), "${param1}, $(uuid)"));	
	// console.log(executeCommand(message, "if ${text}(\\w+)\\s+(\\w+)=echo \\0=return;first=\\1;second=\\2;handled=true"));
	// let config = loadConfig("./conf/jms-regexp.conf");
	// console.log(config);
	// let context = "${text}(\\w+)\\s+(\\w+)=echo \\1;marked=\\2;handled=true";
	// console.log("Test 1:", contexts.get("test")(message));
	// console.log("Test 2:", contexts.get("echo2")(message2));
// }
// test().catch(console.error);

async function main() {
	load(CONFIGFILE);
	JENGINE.install("jengine.command", onCommand);
	JENGINE.install("jengine.halt", onHalt);
	JENGINE.info("Regexp module started.");
}

main().catch(JENGINE.error);
