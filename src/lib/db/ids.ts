export const isoNow = (): string => new Date().toISOString();
export const newId = (): string => crypto.randomUUID();
