import EventEmitter from 'events';
import BasePlugin from './base-plugin.js';
import Logger from 'core/logger';
import manager from './utils/rotation.js';

EventEmitter.defaultMaxListeners = Math.max(20, EventEmitter.defaultMaxListeners);

const NO_VOTE_HELD = 1
const VOTE_IN_PROGRESS = 2
const VOTE_SUCCEEDED = 3
const VOTE_FAILED = 4
const MAP_IS_SELECTED_BY_VOTE = 5
const VOTE_SEMAPHOR = 6

const PLUGIN_NAME = 'SkipVote'
const LOG_INFO = 1
const LOG_VERBOSE = 2
const LOG_DEBUG = 3

function diff_seconds(t2, t1) {
    return Math.round((t2 - t1) / 1000)
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export default class SkipmapVote extends BasePlugin {
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
            wait_before_vote: {
                required: false,
                description: 'Time (in seconds) required to wait before allowing to vote in match.',
                default: 7
            },
            ratio_needed_to_pass: {
                required: false,
                description: 'Ratio of voices needed for vote to pass (from 0% to 100%).',
                default: 25
            },
            command_keywords: {
                required: false,
                description: 'Keywords that trigger skip command to fire.',
                default: ['skipmap']
            },
            vote_duration: {
                required: false,
                description: 'Time (in seconds) that script waits to gather voices during vote.',
                default: 60
            },
            vote_window: {
                required: false,
                description: 'Time (in seconds) that players have after map start to invoke a vote.',
                default: 120
            },
            wait_before_map_skip: {
                required: false,
                description: 'Time (in seconds) to wait before skip if vote was successfull.',
                default: 5
            },
            text_vote_already_triggered: {
                required: false,
                description: 'Warn that gets shown if there has already been a vote on this map.',
                default: 'There is/was a vote already on this map.'
            },
            text_was_selected_by_vote: {
                required: false,
                description: 'Warn that gets shown if there has already been a vote on this map.',
                default: 'This map was selected by previous vote, wait for next round to vote.'
            },
            text_generic_vote_fail: {
                required: false,
                description: 'Warn that gets shown for unexpected states of vote.',
                default: 'State does not allow to vote (state=${this.vote_state})'
            },
            text_vote_started: {
                required: false,
                description: 'Broadcast that gets displayed on votes start.',
                default: 'SKIPMAP VOTE STARTED! Vote "+" or "-". ' +
                    '${this.vote_results.next_map === null ? "" : "Next layer: "+this.vote_results.next_map+". "}' +
                    'Votes needed to skip: ${this.options.ratio_needed_to_pass}%.'
            },
            text_vote_failed: {
                required: false,
                description: 'Broadcast that gets displayed if skipmap vote has failed.',
                default: 'Voting results: ${this.vote_results.resulting_score} < ' +
                    '${this.vote_results.target_score} (${this.options.ratio_needed_to_pass}% of ' +
                    '${this.vote_results.total_players}), vote failed.'
            },
            text_vote_succeeded: {
                required: false,
                description: 'Broadcast that gets displayed if skipmap vote has succeeded.',
                default: 'Voting results: ${this.vote_results.resulting_score} >= ' +
                    '${this.vote_results.target_score} (${this.options.ratio_needed_to_pass}% of ' +
                    '${this.vote_results.total_players}), vote passed.'
            },
            text_wait_till_vote: {
                required: false,
                description: 'Warn that gets displayed if vote is invoked too early.',
                default: 'You have to wait for ${this.pre_vote_validation.time_msg}s before calling a vote.'
            },
            text_too_late_for_vote: {
                required: false,
                description: 'Warn that gets displayed if vote is invoked after voting window.',
                default: 'Voting can only be called within ${this.options.vote_window}s after layer was loaded.'
            },
            text_vote_already_failed: {
                required: false,
                description: 'Warn that gets displayed if vote for this map already failed.',
                default: 'There has already been a skipmap vote and it failed.'
            },
            text_semaphor: {
                required: false,
                description: 'Warn that gets displayed if 2 people launch vote almost simultaneously.',
                default: 'Another player already tries to call a vote.'
            },
            text_vote_accepted: {
                required: false,
                description: 'Warn that gets displayed when player\'s vote is accepted.',
                default: 'Vote accepted.'
            }
        };
    }

    constructor(server, options, connectors) {
        super(server, options, connectors);

        this.vote_state = NO_VOTE_HELD;
        this.vote_results = {};
        this.pre_vote_validation = {};

        this.command_aliases = null;
        this.onChatCommand = this.onChatCommand.bind(this);
        this.onNewGame = this.onNewGame.bind(this);
        this.onChatMessage = this.onChatMessage.bind(this);
        Logger.verbose(PLUGIN_NAME, LOG_DEBUG, 'Plugin is constructed.')
    }

    template(str_input, extra = null) {
        let formatter = new Function(
            'extra',
            'return `' + str_input.replace(/([^\\])[`].*$/, "$1") + '`');
        formatter = formatter.bind(this);
        return formatter(extra);
    } // dangerous way of formatting strings

    update_game_state() {
        if (this.vote_state == VOTE_SUCCEEDED) {
            this.vote_state = MAP_IS_SELECTED_BY_VOTE;
            return;
        }
        this.vote_state = NO_VOTE_HELD;
        // build time data
        this.pre_vote_validation = {};
        let match_start_time = new Date(this.server.layerHistory[0].time);
        this.pre_vote_validation.available_after = new Date(
            match_start_time.getTime() +
            this.options.wait_before_vote * 1000);
        this.pre_vote_validation.available_until = new Date(
            match_start_time.getTime() +
            this.options.vote_window * 1000);
        Logger.verbose(
            PLUGIN_NAME,
            LOG_DEBUG,
            `Vote bounds for new map:\n    match start: ${match_start_time}\n` +
            `    vote after:  ${this.pre_vote_validation.available_after}\n` +
            `    vote until:  ${this.pre_vote_validation.available_until}`
        );
    }

    async mount() {
        this.command_aliases = this.options.command_keywords;
        this.command_aliases.forEach(command => {
            Logger.verbose(PLUGIN_NAME, LOG_INFO, `Registering command !${command}.`);
            this.server.on(`CHAT_COMMAND:${command}`, this.onChatCommand)
        });
        this.server.on('NEW_GAME', this.onNewGame);
        this.server.on('CHAT_MESSAGE', this.onChatMessage);
        this.update_game_state();
        Logger.verbose(PLUGIN_NAME, LOG_VERBOSE, 'Plugin is mounted.');
    }

    async unmount() {
        this.command_aliases.forEach(command => {
            Logger.verbose(PLUGIN_NAME, LOG_INFO, `Unregistering command !${command}.`);
            this.server.removeEventListener(`CHAT_COMMAND:${command}`, this.onChatCommand);
        });
        this.server.removeEventListener('NEW_GAME', this.onNewGame);
        this.server.removeEventListener('CHAT_MESSAGE', this.onChatMessage);
        Logger.verbose(PLUGIN_NAME, LOG_VERBOSE, 'Plugin is unmounted.');
    }

    async onNewGame(info) {
        this.update_game_state();
    }

    async onChatMessage(info) {
        if (this.vote_state != VOTE_IN_PROGRESS) {
            return;
        }
        Logger.verbose(PLUGIN_NAME, LOG_DEBUG, 'Recieved chat message, testing if is a vote.');
        const vote = info.message.match(/^\s*([+=-])/)
        if (vote) {
            await this.registerVote(info.player.steamID, vote[1]);
        }
    }

    async registerVote(steamid, vote) {
        if (steamid in this.vote_results.votes) {
            if (this.vote_results.votes[steamid] == vote) {
                return
            }
        }
        this.vote_results.votes[steamid] = vote;
        await this.server.rcon.warn(steamid, this.template(this.options.text_vote_accepted, vote));
        Logger.verbose(PLUGIN_NAME, LOG_VERBOSE, `registered vote from ${steamid}: ${vote}`);
    }

    async onChatCommand(info) {
        Logger.verbose(PLUGIN_NAME, LOG_VERBOSE, 'Starting a vote request check.');
        let is_valid = await this.validate_vote_call(info);
        if (is_valid) {
            Logger.verbose(PLUGIN_NAME, LOG_VERBOSE, 'Starting a vote itself.');
            await this.run_vote();
        };
    }

    async validate_vote_call(info) {
        // if (info.chat !== 'ChatAdmin') return false; // limit to admin chat while testing
        let invoker_ID = info.player.steamID;
        let current_state = this.vote_state;

        // just count voice if already voting
        if (this.vote_state == VOTE_IN_PROGRESS) {
            this.registerVote(invoker_ID, '+');
            Logger.verbose(PLUGIN_NAME, LOG_DEBUG, 'Vote in progress, registering voice.');
            this.vote_state = current_state; // revert back after checking
            return
        };

        // shitty race condition protection
        if (this.vote_state == VOTE_SEMAPHOR) {
            await this.server.rcon.warn(invoker_ID, this.template(this.options.text_semaphor));
            Logger.verbose(PLUGIN_NAME, LOG_DEBUG, 'Vote request failed on VOTE_SEMAPHOR.');
            return false;
        };

        this.vote_state = VOTE_SEMAPHOR;

        let invoked_at = new Date();
        this.pre_vote_validation.invoker_ID = invoker_ID;

        // if state does not allow for vote
        if (current_state != NO_VOTE_HELD) {
            let message = this.options.text_generic_vote_fail
            switch (current_state) {
                case MAP_IS_SELECTED_BY_VOTE:
                    message = this.options.text_was_selected_by_vote;
                    Logger.verbose(PLUGIN_NAME, LOG_DEBUG, 'Vote request failed on MAP_IS_SELECTED_BY_VOTE.');
                    break;
                case VOTE_SUCCEEDED:
                    message = this.options.text_vote_already_triggered;
                    Logger.verbose(PLUGIN_NAME, LOG_DEBUG, 'Vote request failed on VOTE_SUCCEEDED.');
                    break;
                case VOTE_FAILED:
                    message = this.options.text_vote_already_failed;
                    Logger.verbose(PLUGIN_NAME, LOG_DEBUG, 'Vote request failed on VOTE_FAILED.');
                    break;
            };
            await this.server.rcon.broadcast(this.template(message));
            this.vote_state = current_state; // revert back after checking
            return false;
        };
        // if time does not allow for vote
        let time_diff = diff_seconds(this.pre_vote_validation.available_after, invoked_at) // check if not too early to invoke a vote 
        if (time_diff > 0) {
            this.pre_vote_validation.time_msg = time_diff;
            await this.server.rcon.broadcast(this.template(this.options.text_wait_till_vote));
            Logger.verbose(PLUGIN_NAME, LOG_DEBUG, 'Vote request too early.');
            this.vote_state = current_state; // revert back after checking
            return false;
        }
        time_diff = diff_seconds(invoked_at, this.pre_vote_validation.available_until) // check if not too early to invoke a vote 
        if (time_diff > 0) {
            this.pre_vote_validation.time_msg = time_diff;
            await this.server.rcon.broadcast(this.template(this.options.text_too_late_for_vote));
            Logger.verbose(PLUGIN_NAME, LOG_DEBUG, 'Vote request too late.');
            this.vote_state = current_state; // revert back after checking
            return false;
        }
        return true;
    }

    async run_vote() {
        // starting a vote
        let invoker_ID = this.pre_vote_validation.invoker_ID;
        let next_map = this.server.nextLayer === null ? null : this.server.nextLayer.layerid;

        this.vote_results = {
            positives: 0,
            negatives: 0,
            votes: {},
            total_players: 0,
            resulting_score: 0,
            target_score: 0,
            next_map: next_map
        }
        await this.registerVote(invoker_ID, '+');
        this.vote_state = VOTE_IN_PROGRESS;
        // TODODO


        await this.server.rcon.broadcast(
            this.template(this.options.text_vote_started)
        );
        Logger.verbose(PLUGIN_NAME, LOG_DEBUG, `Waiting for votes to take place (${this.options.vote_duration}s)`);
        await delay(this.options.vote_duration * 1000);

        // counting votes
        let positives = 0;
        let negatives = 0;
        let total_players = this.server.players.length;
        let target_score = Math.ceil(this.options.ratio_needed_to_pass * total_players * 0.01);
        for (let [k, v] of Object.entries(this.vote_results.votes)) {
            switch (v) {
                case '+': positives++; break;
                case '-': negatives++;
            }
        }
        let resulting_score = positives - negatives;

        this.vote_results.positives = positives;
        this.vote_results.negatives = negatives;
        this.vote_results.total_players = total_players;
        this.vote_results.resulting_score = resulting_score;
        this.vote_results.target_score = target_score;
        Logger.verbose(
            PLUGIN_NAME,
            LOG_DEBUG,
            `Voting score: ${resulting_score} ` +
            `${resulting_score < target_score ? '<' : '>='} ` +
            `${target_score}.`
        );

        if (resulting_score < target_score) {
            this.vote_state = VOTE_FAILED;
            await this.server.rcon.broadcast(
                this.template(this.options.text_vote_failed)
            );
        } else {
            this.vote_state = VOTE_SUCCEEDED;
            await this.server.rcon.broadcast(
                this.template(this.options.text_vote_succeeded)
            );
            await delay(this.options.wait_before_map_skip * 1000);
            await this.server.rcon.execute('AdminEndMatch');
            this.verbose(1, `Map was skipped: ${manager.layers_history[0]}`);
        }
    }
}
