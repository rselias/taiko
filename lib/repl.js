const fs = require('fs-extra');
const path = require('path');
const util = require('util');
const { aEval } = require('./awaitEval');
const taiko = require('./taiko');
const { removeQuotes, symbols } = require('./util');
const funcs = {};
let commands = [];
const stringColor = util.inspect.styles.string;
let taikoCommands = {};
let pluginCommands = {};
let lastStack = '';
let version = '';
let browserVersion = '';
let doc = '';

module.exports.initialize = async (plugins, previousSessionFile) => {
    await setVersionInfo();
    const repl = require('repl').start({ prompt: '> ', ignoreUndefined: true });
    repl.writer = writer(repl.writer);
    aEval(repl, (cmd, res) => !util.isError(res) && commands.push(cmd.trim()));
    initTaiko(repl, plugins);
    initCommands(repl, previousSessionFile);
    return repl;
};

async function setVersionInfo() {
    try {
        version = require('../package.json').version;
        doc = require('./api.json');
        browserVersion = require('../package.json').taiko.chromium_version;
    } catch (_) { }
    displayTaiko();
}

const writer = w => output => {
    if (util.isError(output)) return output.message;
    else if (typeof (output) === 'object' && 'description' in output) {
        output.description = symbols.pass + output.description;
        return removeQuotes(util.inspect(output.description, { colors: true }), output.description);
    } else return w(output);
};

function initCommands(repl, previousSessionFile) {
    repl.defineCommand('trace', {
        help: 'Show last error stack trace',
        action() {
            console.log(lastStack ? lastStack : util.inspect(undefined, { colors: true }));
            this.displayPrompt();
        }
    });
    repl.defineCommand('code', {
        help: 'Prints or saves the code for all evaluated commands in this REPL session',
        action(file) {
            if (!file) console.log(code());
            else writeCode(file, previousSessionFile);
            this.displayPrompt();
        }
    });
    repl.defineCommand('step', {
        help: 'Generate gauge steps from recorded script. (openBrowser and closeBrowser are not recorded as part of step)',
        action(file) {
            if (!file) console.log(step());
            else writeStep(file);
            this.displayPrompt();
        }
    });
    repl.defineCommand('version', {
        help: 'Prints version info',
        action() {
            console.log(`${version} (${browserVersion})`);
            this.displayPrompt();
        }
    });
    repl.defineCommand('api', {
        help: 'Prints api info',
        action(name) {
            if (!doc) console.log('API usage not available.');
            else if (name) displayUsageFor(name);
            else displayUsage();
            this.displayPrompt();
        }
    });
    repl.on('reset', () => {
        commands.length = 0;
        taikoCommands = {};
        lastStack = '';
    });
    repl.on('exit', () => {
        if (taiko.client()) taiko.closeBrowser();
    });
}

function code() {
    if (commands[commands.length - 1].includes('closeBrowser()')) commands.pop();
    const text = commands.map(e => {
        if (!e.endsWith(';')) e += ';';
        return isTaikoFunc(e) ? '        await ' + e : '\t' + e;
    }).join('\n');

    let pluginImports = Object.keys(pluginCommands).map((plugin) => {
        let cmds = Object.keys(pluginCommands[plugin]);
        if (cmds.length <= 0) return '';
        return `const {ID, clientHandler, ${cmds.join(', ')} } = require('taiko-${plugin}');\n`
            + 'loadPlugin(ID, clientHandler);\n';
    }, '').join('\n');
    if (pluginImports) taikoCommands['loadPlugin'] = true;

    const cmds = Object.keys(taikoCommands);
    if (!cmds.includes('closeBrowser')) cmds.push('closeBrowser');
    const importTaiko = cmds.length > 0 ? `const { ${cmds.join(', ')} } = require('taiko');\n` : '';
    return importTaiko + pluginImports + `(async () => {
    try {
${ text}
    } catch (e) {
        console.error(e);
    } finally {
        await closeBrowser();
    }
})();
`;
}

function step(withImports = false, actions = commands) {
    if (actions[0].includes('openBrowser(')) actions = actions.slice(1);
    if (actions.length && actions[actions.length - 1].includes('closeBrowser()')) actions = actions.slice(0, -1);
    const actionsString = actions.map(e => {
        if (!e.endsWith(';')) e += ';';
        return isTaikoFunc(e) ? '\tawait ' + e : '\t' + e;
    }).join('\n');

    const cmds = Object.keys(taikoCommands).filter((c) => {
        return c !== 'openBrowser' && c !== 'closeBrowser';
    });
    const importTaiko = cmds.length > 0 ? `const { ${cmds.join(', ')} } = require('taiko');\n` : '';
    const step = !actionsString ? '' : `\n// Insert step text below as first parameter\nstep("", async function() {\n${actionsString}\n});\n`;
    return !withImports ? step : `${importTaiko}${step}`;
}

function writeStep(file) {
    if (fs.existsSync(file)) {
        fs.appendFileSync(file, step());
    } else {
        fs.ensureFileSync(file);
        fs.writeFileSync(file, step(true));
    }
}

function writeCode(file, previousSessionFile) {
    try {
        if (fs.existsSync(file)) {
            fs.appendFileSync(file, code());
        } else {
            fs.ensureFileSync(file);
            fs.writeFileSync(file, code());
        }
        if (previousSessionFile) {
            console.log(`Recorded session to ${file}.`);
            if (path.resolve(file) === path.resolve(previousSessionFile)) {
                console.log(`Please update contents of ${previousSessionFile} before running it with taiko.`);
            } else {
                console.log(`The previous session was recorded in ${previousSessionFile}.`);
                console.log(`Please merge contents of ${previousSessionFile} and ${file} before running it with taiko.`);
            }
        }
    } catch (error) {
        console.log(`Failed to write to ${file}.`);
        console.log(error.stacktrace);
    }
}

function initTaiko(repl, plugins) {
    const openBrowser = taiko.openBrowser;
    taiko.openBrowser = async (options = {}) => {
        if (!options.headless) options.headless = false;
        return await openBrowser(options);
    };
    addFunctionToRepl(taiko, repl);
    plugins.forEach((plugin) => {
        pluginCommands[plugin.ID] = {};
        addFunctionToRepl(plugin, repl, true);
    });
}

function addFunctionToRepl(target, repl, isPlugin = false) {
    for (let func in target) {
        if (target[func].constructor.name === 'AsyncFunction')
            repl.context[func] = async function () {
                try {
                    lastStack = '';
                    let args = await Promise.all(Object.values(arguments));
                    const res = await target[func].apply(this, args);
                    if (isPlugin) {
                        pluginCommands[target.ID][func] = true;
                    } else {
                        taikoCommands[func] = true;
                    }
                    return res;
                }
                catch (e) {
                    return handleError(e);
                }
                finally {
                    util.inspect.styles.string = stringColor;
                }
            };
        else
            repl.context[func] = function () {
                if (isPlugin) {
                    pluginCommands[target.ID][func] = true;
                } else {
                    taikoCommands[func] = true;
                }
                const res = target[func].apply(this, arguments);
                if (res.exists) {
                    let existsFunc = res.exists;
                    let wrraper = async () => {
                        let v = await existsFunc();
                        if (v)
                            return { description: 'Exists' };
                        return { description: 'Does not Exist' };
                    };
                    res.exists = wrraper;
                }
                return res;
            };
        funcs[func] = true;
    }
}

function displayTaiko() {
    console.log(`\nVersion: ${version} (Chromium:${browserVersion})`);
    console.log('Type .api for help and .exit to quit\n');
}

function displayUsageFor(name) {
    const e = doc.find(e => e.name === name);
    if (!e) {
        console.log(`Function ${name} doesn't exist.`);
        return;
    }
    console.log();
    console.log(desc(e.description));
    if (e.examples.length > 0) {
        console.log();
        console.log(e.examples.length > 1 ? 'Examples:' : 'Example:');
        console.log(e.examples
            .map(e => e.description.split('\n').map(e => '\t' + e).join('\n'))
            .join('\n'));
        console.log();
    }
}

function displayUsage() {
    for (let k in taiko.metadata)
        console.log(`
${removeQuotes(util.inspect(k, { colors: true }), k)}
    ${taiko.metadata[k].join(', ')}`);
    console.log(`
Run \`.api <name>\` for more info on a specific function. For Example: \`.api click\`.
Complete documentation is available at http://taiko.gauge.org.
`);
}

function handleError(e) {
    util.inspect.styles.string = 'red';
    lastStack = removeQuotes(util.inspect(e.stack, { colors: true }), e.stack);
    e.message = symbols.fail + 'Error: ' + e.message + ', run `.trace` for more info.';
    return new Error(removeQuotes(util.inspect(e.message, { colors: true }), e.message));
}

const desc = d => d.children
    .map(c => (c.children || [])
        .map((c1, i) => {
            if (c1.type === 'listItem')
                return (i === 0 ? '\n\n* ' : '\n* ') + c1.children[0].children.map(c2 => c2.value).join('');
            return (c1.type === 'link' ? c1.children[0].value : (c1.value || '')).trim();
        })
        .join(' '))
    .join(' ');

const isTaikoFunc = keyword => keyword.split('(')[0] in funcs;