import {ReactElement} from "react";
import {StageBase, StageResponse, InitialData, Message, TextGenRequest, Character, User} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";
import {Action} from "./Action";
import {Stat, StatDescription} from "./Stat"
import {Outcome, Result, ResultDescription} from "./Outcome";

type MessageStateType = any;

type ConfigType = any;

type InitStateType = any;

type ChatStateType = any;

/*
  nvm use 21.7.1
  yarn install (if dependencies have changed)
  yarn dev --host --mode staging
*/

export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {
    
    readonly defaultStat: number = 0;
    readonly adLibPrompt: string = 'Determine whether the preceding input includes stat-based action or motivated dialog. \n' +
        'If so, merely output the name of the stat that best governs the action or intent, with a relative difficulty modifier between -5 and +5 (higher numbers representing lower risk).\n' +
        'If not, simply output "None".\n' +
        'These are the eight possible stats and their descriptions, to aid in selecting the most applicable:\n' +
        Object.keys(Stat).map(key => `${key}: ${StatDescription[key as Stat]}`).join('\n') + '\n' +
        'Sample responses:\n"Might +1"\n"Skill -2"\n"Grace +0"\n"None"';
    readonly actionPrompt: string = 
        '[INST]Based on the above chat history, output a list of three-to-six options for varied follow-up actions that {{user}} could choose to pursue next.\n' +
        'These options can be simple dialog, immediate reactions, or generic courses of action. ' +
        'If the option involves any risk, an associated stat and difficulty modifier is included. ' +
        'All options follow this format:\n' +
        '-(Stat +Modifier) Brief summary of action\n' +
        'These are all eight possible stats with a brief description and example verb associations:\n' +
        Object.keys(Stat).map(key => `${key}: ${StatDescription[key as Stat]}`).join('\n') +
        'The modifier is a relative difficulty adjustment between -5 and +5 which will be added to the skill check result; give easy tasks a higher number and riskier options a negative number.\n' +
        'Output each option on a separate line. Study the stat descriptions for inspiration and consider the characters\' current situations, motivations, and assets.\n' +
        '[SAMPLE]\n' +
        '-Talk to the guard about admittance.\n' +
        '-(Charm -2) Convince the guard to let you in.\n' +
        '-(Might +1) Force the lock.\n' +
        '-(Skill -1) Pick the lock (it looks difficult).\n' +
        '-(Luck -1) Search for another way in.\n' +
        '-Give up.\n[/SAMPLE]\n' +
        'Although the flavor of the options should excercise creativity, the presentation of these options should be uniform and plain at all times.[/INST]';

    // Regular expression to match the pattern "(Stat +modifier) description"
    readonly actionRegex = /(\w+)\s*([-+]\d+)\s*[^a-zA-Z]+\s*(.*)/; // /(\w+)\s*([-+]\d+)\s*[^a-zA-Z]+\s*(.+)/
    readonly whitespaceRegex = /^[\s\r\n]*$/;
    readonly nonLetterRegex = /^[^a-zA-Z]+/;

    readonly levelThresholds: number[] = [2, 5, 9, 14, 20, 27, 35, 44, 54, 65, 77, 90, 104, 119];
    
    currentMessage: string = '';
    actions: Action[] = [];
    currentMessageId: string|undefined = undefined;
    lastOutcome: Outcome|null = null;
    lastOutcomePrompt: string = '';
    promptForId: string|undefined = undefined;
    player: User;
    character: Character;
    
    // message-level variables
    experience: number = 0;
    messageHistory: string = '';
    statUses: {[stat in Stat]: number} = this.clearStatMap();
    stats: {[stat in Stat]: number} = this.clearStatMap();

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        super(data);
        const {
            characters,
            users,
            config,
            messageState,
            environment,
            initState,
            chatState
        } = data;
        this.setStateFromMessageState(messageState);
        this.player = users[Object.keys(users)[0]];
        this.character = characters[Object.keys(characters)[0]];
    }

    clearStatMap() {
        let statMap = {
            [Stat.Might]: 0,
            [Stat.Grace]: 0,
            [Stat.Skill]: 0,
            [Stat.Brains]: 0,
            [Stat.Wits]: 0,
            [Stat.Charm]: 0,
            [Stat.Heart]: 0,
            [Stat.Luck]: 0
        };

        return statMap;
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {
        return {
            success: true,
            error: null,
            initState: null,
            chatState: null,
        };
    }

    async setState(state: MessageStateType): Promise<void> {
        console.log('setState');
        console.log(state);
        this.setStateFromMessageState(state);
    }

    async addMessageToHistory(message: string, prefix?: string) {
        const threshold = 2000;
        const responsePrefix = prefix ?? '###Response: ';
        if (message.length > 0) {
            this.messageHistory += responsePrefix + message;
        }
        while (this.messageHistory.length > threshold) {
            let responseIndex = this.messageHistory.indexOf(responsePrefix, 1);
            if (responseIndex === -1) {
                return;
            }
            this.messageHistory = this.messageHistory.substring(responseIndex);
        }
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const {
            content,
            anonymizedId,
            isBot,
            promptForId,
            identity
        } = userMessage;

        console.log('beforePrompt:' + promptForId + ';' + identity);
        console.log(userMessage);
        this.promptForId = promptForId ?? undefined;
        this.currentMessageId = identity;

        let errorMessage: string|null = null;
        let takenAction: Action|null = null;
        let finalContent: string|undefined = content;

        // Attempt to parse actions:
        for (let i = 0; i < this.actions.length; i++) {
            const action: Action = this.actions[i];
            if (action.stat && content.toLowerCase().includes(action.stat.toLowerCase())) {
                console.log('Chose action by stat');
                takenAction = action;
                break;
            } else if (content === `${i + 1}` || content === `${i + 1}.`) {
                console.log('Chose action by number');
                takenAction = action;
                break;
            } else if (content.length > 6 && action.description.toLowerCase().includes(content.toLowerCase())) {
                console.log('Chose action by description');
                takenAction = action;
                break;
            }
        }

        if (!takenAction && finalContent) {
            console.log('Ad-lib action.');
            let textGenRequest: TextGenRequest = {
                prompt: `${finalContent}\n[${this.adLibPrompt}]`,
                max_tokens: 100,
                min_tokens: 50,
                stop: [],
                include_history: false,
                template: '',
                context_length: 2000
            };
            let textResponse = await this.generator.textGen(textGenRequest);
            const adLibPattern = new RegExp(`^(${Object.values(Stat).join('|')}) ((\\+|-)\\d+)`);
            console.log('request complete?');
            console.log(textResponse);
            const match = adLibPattern.exec(textResponse?.result ?? '');

            if (match) {
                console.log('Found match');
                let action: Action = new Action(finalContent, match[1] as Stat, Number(match[2]));
                takenAction = action;
            } else {
                let action: Action = new Action(finalContent, null, 0);
                takenAction = action;
            }
        }

        if (takenAction) {
            this.setLastOutcome(takenAction.determineSuccess(takenAction.stat ? this.stats[takenAction.stat] : 0));
            finalContent = this.lastOutcome?.getDescription();

            if (takenAction.stat) {
                this.statUses[takenAction.stat]++;
            }

            if (this.lastOutcome?.result === Result.Failure) {
                this.experience++;
                let level = Object.values(this.stats).reduce((acc, val) => acc + val, 0);
                if (this.experience == this.levelThresholds[level]) {
                    const maxCount = Math.max(...Object.values(this.statUses));

                    const maxStats = Object.keys(this.statUses)
                        .filter((stat) => this.statUses[stat as Stat] === maxCount)
                        .map((stat) => stat as Stat);
                    let chosenStat = maxStats[Math.floor(Math.random() * maxStats.length)];
                    this.stats[chosenStat]++;

                    finalContent += `\n##Welcome to level ${level + 1}!##\n#_${chosenStat}_ up!#`;

                    this.statUses = this.clearStatMap();
                } else {
                    finalContent += `\n#You've learned from this experience...#`
                }
            }
        }

        await this.addMessageToHistory(this.lastOutcomePrompt, '###Input: ');

        return {
            stageDirections: `\n[INST]${this.lastOutcomePrompt}\n[/INST]`,
            messageState: this.buildMessageState(),
            modifiedMessage: finalContent,
            systemMessage: null,
            error: errorMessage,
            chatState: null,
        };
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const {
            content,
            anonymizedId,
            isBot,
            identity
        } = botMessage;

        console.log('afterResponse()');
        this.lastOutcomePrompt = '';

        await this.addMessageToHistory(content);
        
        // Generate options:
        let optionPrompt = this.replaceTags(`[{{char}} DESCRIPTION]\n${this.character.description} ${this.character.personality}[/{{char}} DESCRIPTION]\n[{{user}} DESCRIPTION]\n${this.player.chatProfile}[/{{user}} DESCRIPTION]\n[HISTORY]\n${this.messageHistory}\n[/HISTORY]\n${this.actionPrompt}`,
            {"user": this.player.name, "char": this.character.name, "original": ''});
        let optionResponse = await this.generator.textGen({
            prompt: optionPrompt,
            max_tokens: 150
        });

        let tmpActions:Action[] = [];
        
        if (optionResponse && optionResponse.result) {
            console.log(`Option response`);
            console.log(optionResponse.result);
            const lines = optionResponse.result.split('\n');
            const regex = /^[-*]/;

            for (const line of lines) {
                const match = line.match(this.actionRegex);
                if (match && !match[3].match(this.whitespaceRegex) && match[1] in Stat) {
                    console.log('Have an action: ' + match[3] + ';' + match[1] + ';' + match[2]);
                    tmpActions.push(new Action(match[3], match[1] as Stat, Number(match[2])));
                } else if (regex.test(line.trim()) && !line.replace(this.nonLetterRegex, "").match(this.whitespaceRegex)) {
                    console.log('Have a stat-less action: ' + line.replace(this.nonLetterRegex, ""));
                    tmpActions.push(new Action(line.replace(this.nonLetterRegex, ""), null, 0));
                }
            }
        }

        // Trim down options:
        const uniqueStats = new Set<Stat>();
        this.actions = tmpActions.filter(action => {
            if (action.description.trim() == '') {
                return false;
            }
            if (action.stat && !uniqueStats.has(action.stat)) {
                uniqueStats.add(action.stat);
                return true;
            }
            return !(action.stat);
        });
        this.actions.length = Math.min(this.actions.length, 6);

        this.currentMessageId = identity;
        console.log(this.currentMessageId);

        //await this.addMessageToHistory(this.actions.length > 0 ? this.actions.map((action, index) => `${index + 1}. ${action.fullDescription()}`).join('\n') : '', '###Choice: ');

        return {
            stageDirections: null,
            messageState: this.buildMessageState(),
            modifiedMessage: null,
            error: this.actions.length == 0 ? 'Failed to generate actions; consider swiping or write your own.' : null,
            systemMessage: this.actions.length > 0 ? `Choose an action:\n` + this.actions.map((action, index) => `${index + 1}. ${action.fullDescription()}`).join('\n') : null,
            chatState: null
        };
    }

    setStateFromMessageState(messageState: MessageStateType) {
        this.stats = this.clearStatMap();
        if (messageState != null) {
            for (let stat in Stat) {
                this.stats[stat as Stat] = messageState[stat] ?? this.defaultStat;
                this.statUses[stat as Stat] = messageState[`use_${stat}`] ?? 0;
            }
            this.currentMessage= messageState['currentMessage'] ?? '';
            this.currentMessageId = messageState['currentMessageId'] ?? '';
            this.lastOutcome = messageState['lastOutcome'] ? this.convertOutcome(messageState['lastOutcome']) : null;
            this.lastOutcomePrompt = messageState['lastOutcomePrompt'] ?? '';
            this.actions = messageState['actions'] ? messageState['actions'].map((action: any) => {
                return this.convertAction(action);
            }) : [];
            this.promptForId = messageState['promptForId'];
            this.experience = messageState['experience'] ?? 0;
            this.messageHistory = messageState['messageHistory'] ?? '';
        }
    }

    convertOutcome(input: any): Outcome {
        return new Outcome(input['dieResult1'], input['dieResult2'], this.convertAction(input['action']));
    }

    convertAction(input: any): Action {
        return new Action(input['description'], input['stat'] as Stat, input['modifier'])
    }

    buildMessageState(): any {
        let messageState: {[key: string]: any} = {};
        for (let stat in Stat) {
            messageState[stat] = this.stats[stat as Stat] ?? this.defaultStat;
            messageState[`use_${stat}`] = this.statUses[stat as Stat] ?? 0;
        }
        messageState['currentMessage'] = this.currentMessage ?? '';
        messageState['currentMessageId'] = this.currentMessageId ?? '';
        messageState['lastOutcome'] = this.lastOutcome ?? null;
        messageState['lastOutcomePrompt'] = this.lastOutcomePrompt ?? '';
        messageState['actions'] = this.actions ?? [];
        messageState['promptForId'] = this.promptForId;
        messageState['experience'] = this.experience ?? 0;
        messageState['messageHistory'] = this.messageHistory;

        return messageState;
    }

    setLastOutcome(outcome: Outcome|null) {
        this.lastOutcome = outcome;
        this.lastOutcomePrompt = '';
        if (this.lastOutcome) {
            this.lastOutcomePrompt += `The user has chosen the following action: ${this.lastOutcome.action.description}\n`;
            this.lastOutcomePrompt += `${ResultDescription[this.lastOutcome.result]}\n`
        }
    }

    replaceTags(source: string, replacements: {[name: string]: string}) {
        return source.replace(/{{([A-z]*)}}/g, (match) => {
            return replacements[match.substring(2, match.length - 2)];
        });
    }

    render(): ReactElement {
        return <div style={{
            width: '100vw',
            height: '100vh',
            display: 'grid',
            alignItems: 'stretch'
        }}>
            <div>{this.currentMessage}</div>
            <div>{this.actionPrompt}</div>
        </div>;
    }

}
