import type { ParsedResponse, GameEngine, ActionResult } from './types.mjs';
export declare const structuredResponseSchema: {
    readonly type: "object";
    readonly properties: {
        readonly thinking: {
            readonly type: "string";
            readonly maxLength: 512;
        };
        readonly action_required: {
            readonly type: "string";
            readonly enum: readonly ["roll_dice", "update_state", "none"];
        };
        readonly action_params: {
            readonly type: "object";
            readonly properties: {
                readonly formula: {
                    readonly type: "string";
                    readonly maxLength: 80;
                };
                readonly target: {
                    readonly type: "string";
                    readonly maxLength: 100;
                };
                readonly reason: {
                    readonly type: "string";
                    readonly maxLength: 600;
                };
                readonly field: {
                    readonly type: "string";
                    readonly maxLength: 64;
                };
                readonly value: {
                    readonly type: readonly ["string", "number", "boolean", "null"];
                };
            };
            readonly additionalProperties: false;
        };
        readonly narrative_text: {
            readonly type: "string";
            readonly maxLength: 30000;
        };
    };
    readonly required: readonly ["thinking", "action_required", "action_params", "narrative_text"];
    readonly additionalProperties: false;
};
export declare const structuredResponseFormat: {
    readonly type: "json_object";
    readonly schema: {
        readonly type: "object";
        readonly properties: {
            readonly thinking: {
                readonly type: "string";
                readonly maxLength: 512;
            };
            readonly action_required: {
                readonly type: "string";
                readonly enum: readonly ["roll_dice", "update_state", "none"];
            };
            readonly action_params: {
                readonly type: "object";
                readonly properties: {
                    readonly formula: {
                        readonly type: "string";
                        readonly maxLength: 80;
                    };
                    readonly target: {
                        readonly type: "string";
                        readonly maxLength: 100;
                    };
                    readonly reason: {
                        readonly type: "string";
                        readonly maxLength: 600;
                    };
                    readonly field: {
                        readonly type: "string";
                        readonly maxLength: 64;
                    };
                    readonly value: {
                        readonly type: readonly ["string", "number", "boolean", "null"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly narrative_text: {
                readonly type: "string";
                readonly maxLength: 30000;
            };
        };
        readonly required: readonly ["thinking", "action_required", "action_params", "narrative_text"];
        readonly additionalProperties: false;
    };
};
export declare function isStructuredResponse(raw: unknown): boolean;
export declare function parseLLMResponse(raw: unknown): ParsedResponse;
export declare function isValidatedResponse(value: unknown): value is ParsedResponse;
export declare function responseParseError(value: unknown): string | undefined;
export declare function executeAction(response: ParsedResponse, engine: GameEngine): ActionResult;
export declare function executeActionAsync(response: ParsedResponse, engine: GameEngine): Promise<ActionResult>;
