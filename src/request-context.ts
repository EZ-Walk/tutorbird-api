import { AsyncLocalStorage } from "node:async_hooks";

export type RequestAuth = { authorization: string };

export const requestAuth = new AsyncLocalStorage<RequestAuth>();
