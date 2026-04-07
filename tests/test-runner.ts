import nodeTest from "node:test";

export function test(...args: Parameters<typeof nodeTest>): void {
	void nodeTest(...args);
}
