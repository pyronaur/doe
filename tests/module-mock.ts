import { registerHooks } from "node:module";

type MockExports = Record<string, unknown>;

const MOCK_SCHEME = "doe-mock:";
const specifierToId = new Map<string, string>();
const idToExports = new Map<string, MockExports>();
let nextId = 1;
let hooksInstalled = false;

function isIdentifier(name: string): boolean {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function buildMockSource(id: string): string {
	const entry = readMockModuleExports(id);
	const names = Object.keys(entry).filter((name) => name !== "default" && isIdentifier(name));
	return [
		`import { readMockModuleExports } from ${JSON.stringify(import.meta.url)};`,
		`const entry = readMockModuleExports(${JSON.stringify(id)});`,
		...names.map((name) => `export const ${name} = entry[${JSON.stringify(name)}];`),
		"export default entry.default;",
	].join("\n");
}

function installHooks() {
	if (hooksInstalled) {
		return;
	}
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const id = specifierToId.get(specifier);
			if (!id) {
				return nextResolve(specifier, context);
			}
			return {
				shortCircuit: true,
				url: `${MOCK_SCHEME}${id}`,
			};
		},
		load(url, context, nextLoad) {
			if (!url.startsWith(MOCK_SCHEME)) {
				return nextLoad(url, context);
			}
			const id = url.slice(MOCK_SCHEME.length);
			return {
				format: "module",
				shortCircuit: true,
				source: buildMockSource(id),
			};
		},
	});
	hooksInstalled = true;
}

export function readMockModuleExports(id: string): MockExports {
	const entry = idToExports.get(id);
	if (!entry) {
		throw new Error(`Unknown mocked module id "${id}".`);
	}
	return entry;
}

export function mockModule(specifier: string, factory: () => MockExports) {
	installHooks();
	const id = `mock-${nextId}`;
	nextId += 1;
	specifierToId.set(specifier, id);
	idToExports.set(id, factory());
}
