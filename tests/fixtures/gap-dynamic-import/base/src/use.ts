export async function loadDynamic(name: string): Promise<unknown> {
  return import(name);
}

export async function loadLiteral(): Promise<string> {
  const mod = await import("./greet.js");
  return mod.greet();
}
