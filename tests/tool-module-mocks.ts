import { mockModule } from "./module-mock.ts";

interface ToolMockOptions {
	includeContainer?: boolean;
	includePiAi?: boolean;
	includeTypeboxCollections?: boolean;
}

function buildTypeboxModule(includeCollections: boolean) {
	return {
		Type: {
			Object: (value: unknown) => value,
			String: () => ({ type: "string" }),
			Optional: (value: unknown) => value,
			Boolean: () => ({ type: "boolean" }),
			...(includeCollections
				? {
					Record: (key: unknown, value: unknown) => ({ type: "record", key, value }),
					Any: () => ({ type: "any" }),
					Array: (value: unknown) => ({ type: "array", value }),
				}
				: {}),
		},
	};
}

function buildPiTuiModule(includeContainer: boolean) {
	return {
		...(includeContainer ? { Container: class Container {} } : {}),
		Text: class Text {
			text: string;
			x: number;
			y: number;

			constructor(text: string, x = 0, y = 0) {
				this.text = text;
				this.x = x;
				this.y = y;
			}
		},
	};
}

export function mockToolModules(options: ToolMockOptions = {}) {
	mockModule("@sinclair/typebox",
		() => buildTypeboxModule(options.includeTypeboxCollections ?? false));

	if (options.includePiAi) {
		mockModule("@mariozechner/pi-ai", () => ({
			StringEnum: (value: unknown) => value,
		}));
	}

	mockModule("@mariozechner/pi-tui", () => buildPiTuiModule(options.includeContainer ?? false));
	mockModule("@mariozechner/pi-coding-agent", () => ({}));
}
