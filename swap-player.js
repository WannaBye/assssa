import BasePlugin from './base-plugin.js';

const LOG_INFO = 1
const LOG_VERBOSE = 2
const LOG_DEBUG = 3

function diff_seconds(t2, t1) {
    return Math.round((t2 - t1) / 1000)
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function format_time(dt) {
    return String(Math.floor(dt / 360000)) + ":" +
        String(Math.floor(dt / 60000) % 60).padStart(2, '0') + ":" +
        String(Math.floor(dt / 1000) % 60).padStart(2, '0')
}

export default class SwapPlayer extends BasePlugin {
    static get description() {
        return (
            'The <code>SkipmapVote</code> plugin allows players to vote on skipping specific maps ' +
            'if vote threshold is met. [TODO: gather statistics on votes.]'
        );
    }

    static get defaultEnabled() {
        return false;
    }

    static get optionsSpecification() {
        return {
            command_keywords: {
                required: false,
                description: 'Keywords that trigger skip command to fire.',
                default: ['swap']
            },
            command_cooldown: {
                required: false,
                description: 'Cooldown before swap executions, in milliseconds.',
                default: 3 * 60 * 60 * 1000
            },
            deny_message: {
                required: false,
                description: 'Message to display when swap is denied. Us `dt` variable in templating to display time left.',
                default: 'You will be able to use swap again after ${dt}.'
            }
        };
    }

    constructor(server, options, connectors) {
        super(server, options, connectors);

        this.history = {};
        this.command_aliases = [];
        this.onChatCommand = this.onChatCommand.bind(this);
        this.verbose(LOG_DEBUG, 'Plugin is constructed.')
    }

    template(str_input, extra = 'extra') {
        this.verbose(LOG_INFO, `Extra is ${extra}.`);
        let formatter = new Function(
            extra,
            'return `' + str_input.replace(/([^\\])[`].*$/, "$1") + '`');
        formatter = formatter.bind(this);
        return formatter;
    } // dangerous way of formatting strings

    async mount() {
        this.command_aliases = this.options.command_keywords;
        this.command_aliases.forEach(command => {
            this.verbose(LOG_INFO, `Registering command !${command}.`);
            this.server.on(`CHAT_COMMAND:${command}`, this.onChatCommand)
        });
        this.verbose(LOG_VERBOSE, 'Plugin is mounted.');
    }

    async unmount() {
        this.command_aliases.forEach(command => {
            this.verbose(LOG_INFO, `Unregistering command !${command}.`);
            this.server.removeEventListener(`CHAT_COMMAND:${command}`, this.onChatCommand);
        });
        this.verbose(LOG_VERBOSE, 'Plugin is unmounted.');
    }

    async onChatCommand(info) {
        this.verbose(LOG_VERBOSE, 'Firing swap command.');
        let id = info.player.steamID;
        let time = Date.now();
        if (id in this.history) {
            let dt = time - this.history[id];
            let block_for = this.options.command_cooldown;
            if (dt < block_for) {
                this.server.rcon.warn(
                    id,
                    this.template(this.options.deny_message, 'dt')(format_time(block_for - dt))
                )
                return false;
            }
        }
        this.history[id] = time;
        this.server.rcon.switchTeam(id);
        return true;
    }
}
