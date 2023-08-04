import { delay } from "https://deno.land/std@0.197.0/async/delay.ts";
import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { HTTPHeaderLink } from "./header/link.ts";
import { exponentialBackoffWithJitter } from "./internal/jitter.ts";
const statusCodeRetryable: Set<number> = new Set<number>([408, 429, 500, 502, 503, 504, 506, 507, 508]);
interface ExFetchPaginateOptionsBase {
	/**
	 * Maximum amount of pages to paginate.
	 * @default Infinity
	 */
	count: number;
	/**
	 * Custom link up to the next page, useful for the endpoints which not correctly return an absolute or relative URL.
	 * @param {URL} currentURL URL of the current page.
	 * @param {HTTPHeaderLink} currentHeaderLink Header link of the current page.
	 * @returns {URL} URL of the next page.
	 */
	linkUpNextPage?: (currentURL: URL, currentHeaderLink: HTTPHeaderLink) => URL;
	/**
	 * Pause between pages resource request, by milliseconds.
	 * @default 0 // (Disable)
	 */
	pause: number;
	/**
	 * Whether to throw an error when the latest page response provide an invalid HTTP header link.
	 * @default true
	 */
	throwOnInvalidHeaderLink: boolean;
}
export interface ExFetchPaginateOptions extends Partial<ExFetchPaginateOptionsBase> { }
interface ExFetchRetryOptionsBase {
	/**
	 * Maximum amount of attempts until failure.
	 * @default 4
	 */
	attempts: number;
	/**
	 * How much to backoff after each retry. This only apply when the endpoint have not provide any retry information in the response.
	 * @default 2
	 */
	backoffMultiplier: number;
	/**
	 * Custom retry condition.
	 * @param {number} responseStatusCode Response status code.
	 * @param {boolean} retryable Whether the response status code is retryable according to the standard HTTP status code.
	 * @returns {boolean} Result.
	 * @default undefined
	 */
	condition?: (responseStatusCode: number, retryable: boolean) => boolean;
	/**
	 * Maximum delay between attempts, by milliseconds. This only apply when the endpoint have not provide any retry information in the response.
	 * @default 60000
	 */
	delayMaximum: number;
	/**
	 * Initial and minimum delay between attempts, by milliseconds. This only apply when the endpoint have not provide any retry information in the response.
	 * @default 1000
	 */
	delayMinimum: number;
	/**
	 * Amount of jitter to introduce to the time between attempts. This only apply when the endpoint have not provide any retry information in the response.
	 * @default 1 // (Full jitter)
	 */
	jitter: number;
}
export interface ExFetchRetryOptions extends Partial<ExFetchRetryOptionsBase> {
	/** @alias attempts */attemptsMax?: number;
	/** @alias attempts */attemptsMaximum?: number;
	/** @alias attempts */maxAttempts?: number;
	/** @alias attempts */maximumAttempts?: number;
	/** @alias backoffMultiplier */backoffMultiply?: number;
	/** @alias backoffMultiplier */multiplier?: number;
	/** @alias backoffMultiplier */multiply?: number;
	/** @alias delayMaximum */delayMax?: number;
	/** @alias delayMaximum */maxDelay?: number;
	/** @alias delayMaximum */maximumDelay?: number;
	/** @alias delayMaximum */maximumTimeout?: number;
	/** @alias delayMaximum */maxTimeout?: number;
	/** @alias delayMaximum */timeoutMax?: number;
	/** @alias delayMaximum */timeoutMaximum?: number;
	/** @alias delayMinimum */delayMin?: number;
	/** @alias delayMinimum */minDelay?: number;
	/** @alias delayMinimum */minimumDelay?: number;
	/** @alias delayMinimum */minimumTimeout?: number;
	/** @alias delayMinimum */minTimeout?: number;
	/** @alias delayMinimum */timeoutMin?: number;
	/** @alias delayMinimum */timeoutMinimum?: number;
}
export interface ExFetchOptions {
	/**
	 * Catch up events.
	 * @default undefined
	 */
	event?: EventEmitter;
	/**
	 * Paginate options.
	 * @default {}
	 */
	paginate?: ExFetchPaginateOptions;
	/**
	 * Retry options.
	 * @default {}
	 */
	retry?: ExFetchRetryOptions;
	/**
	 * Timeout of the request (include retries), by milliseconds. This only apply when have not provide `AbortSignal` in the request.
	 * @default Infinity // (Disable)
	 */
	timeout?: number;
}
export type ExFetchEventName = "retry";
export interface ExFetchEventOnRetryPayload {
	/**
	 * Current attempt, begin from `1`.
	 */
	attemptCurrent: number;
	/**
	 * Maximum amount of attempts.
	 */
	attempts: number;
	/**
	 * Will retry again after this amount of time, by milliseconds.
	 */
	retryAfter: number;
	/**
	 * Current response status code.
	 */
	statusCode: number;
	/**
	 * Current response status text.
	 */
	statusText: string;
}
/**
 * Extend `fetch`.
 */
export class ExFetch {
	#event?: EventEmitter;
	#paginate: ExFetchPaginateOptionsBase = {
		count: Infinity,
		pause: 0,
		throwOnInvalidHeaderLink: true
	};
	#retry: ExFetchRetryOptionsBase = {
		attempts: 4,
		backoffMultiplier: 2,
		delayMaximum: 60000,
		delayMinimum: 1000,
		jitter: 1
	};
	#timeout = Infinity;
	/**
	 * @access private
	 * @param {ExFetchPaginateOptions} options
	 * @param {string} prefix
	 * @returns {void}
	 */
	#checkPaginateOptions(options: ExFetchPaginateOptions, prefix: string): void {
		if (typeof options.count === "number" && !Number.isNaN(options.count)) {
			if (options.count !== Infinity && !(Number.isSafeInteger(options.count) && options.count > 0)) {
				throw new RangeError(`Argument \`${prefix}.count\` must be a number which is integer, positive, safe, and > 0!`);
			}
		} else if (typeof options.count !== "undefined") {
			throw new TypeError(`Argument \`${prefix}.count\` must be type of number or undefined!`);
		}
		if (typeof options.linkUpNextPage !== "function" && typeof options.linkUpNextPage !== "undefined") {
			throw new TypeError(`Argument \`${prefix}.linkUpNextPage\` must be type of function or undefined!`);
		}
		if (typeof options.pause === "number" && !Number.isNaN(options.pause)) {
			if (!(Number.isSafeInteger(options.pause) && options.pause >= 0)) {
				throw new RangeError(`Argument \`${prefix}.pause\` must be a number which is integer, positive, and safe!`);
			}
		} else if (typeof options.pause !== "undefined") {
			throw new TypeError(`Argument \`${prefix}.pause\` must be type of number or undefined!`);
		}
		if (typeof options.throwOnInvalidHeaderLink !== "boolean" && typeof options.throwOnInvalidHeaderLink !== "undefined") {
			throw new TypeError(`Argument \`${prefix}.throwOnInvalidHeaderLink\` must be type of boolean or undefined!`);
		}
	}
	/**
	 * Create a new `fetch` instance.
	 * @param {ExFetchOptions} [options={}] Options.
	 */
	constructor(options: ExFetchOptions = {}) {
		options.retry ??= {};
		options.retry.attempts ??= options.retry.attemptsMaximum ?? options.retry.attemptsMax ?? options.retry.maximumAttempts ?? options.retry.maxAttempts;
		options.retry.backoffMultiplier ??= options.retry.backoffMultiply ?? options.retry.multiplier ?? options.retry.multiply;
		options.retry.delayMaximum ??= options.retry.delayMax ?? options.retry.maximumDelay ?? options.retry.maxDelay ?? options.retry.timeoutMaximum ?? options.retry.timeoutMax ?? options.retry.maximumTimeout ?? options.retry.maxTimeout;
		options.retry.delayMinimum ??= options.retry.delayMin ?? options.retry.minimumDelay ?? options.retry.minDelay ?? options.retry.timeoutMinimum ?? options.retry.timeoutMin ?? options.retry.minimumTimeout ?? options.retry.minTimeout;
		if (options.event instanceof EventEmitter) {
			this.#event = options.event;
		} else if (typeof options.event !== "undefined") {
			throw new TypeError(`Argument \`options.event\` must be instance of EventEmitter or type of undefined!`);
		}
		this.#checkPaginateOptions(options.paginate ?? {}, "options.paginate");
		this.#paginate = { ...this.#paginate, ...options.paginate };
		if (typeof options.retry.attempts === "number" && !Number.isNaN(options.retry.attempts)) {
			if (!(Number.isSafeInteger(options.retry.attempts) && options.retry.attempts >= 0)) {
				throw new RangeError(`Argument \`options.retry.attempts\` must be a number which is integer, positive, and safe!`);
			}
			this.#retry.attempts = options.retry.attempts;
		} else if (typeof options.retry.attempts !== "undefined") {
			throw new TypeError(`Argument \`options.retry.attempts\` must be type of number or undefined!`);
		}
		if (typeof options.retry.backoffMultiplier === "number" && !Number.isNaN(options.retry.backoffMultiplier)) {
			if (!(options.retry.backoffMultiplier >= 1 && options.retry.backoffMultiplier <= Number.MAX_SAFE_INTEGER)) {
				throw new RangeError(`Argument \`options.retry.backoffMultiplier\` must be a number which is positive, safe, and >= 1!`);
			}
			this.#retry.backoffMultiplier = options.retry.backoffMultiplier;
		} else if (typeof options.retry.backoffMultiplier !== "undefined") {
			throw new TypeError(`Argument \`options.retry.backoffMultiplier\` must be type of number or undefined!`);
		}
		if (typeof options.retry.condition === "function") {
			try {
				let functionLookUp: unknown = options.retry.condition(randomInt(100, 600), true);
				if (typeof functionLookUp !== "boolean") {
					throw new TypeError(`Argument \`options.retry.condition\` must be return type of boolean!`);
				}
			} catch (error) {
				throw error;
			}
			this.#retry.condition = options.retry.condition;
		} else if (typeof options.retry.condition !== "undefined") {
			throw new TypeError(`Argument \`options.retry.condition\` must be type of function or undefined!`);
		}
		if (typeof options.retry.delayMaximum === "number" && !Number.isNaN(options.retry.delayMaximum)) {
			if (!(Number.isSafeInteger(options.retry.delayMaximum) && options.retry.delayMaximum > 0)) {
				throw new RangeError(`Argument \`options.retry.delayMaximum\` must be a number which is integer, positive, safe, and > 0!`);
			}
			this.#retry.delayMaximum = options.retry.delayMaximum;
		} else if (typeof options.retry.delayMaximum !== "undefined") {
			throw new TypeError(`Argument \`options.retry.delayMaximum\` must be type of number or undefined!`);
		}
		if (typeof options.retry.delayMinimum === "number" && !Number.isNaN(options.retry.delayMinimum)) {
			if (!(Number.isSafeInteger(options.retry.delayMinimum) && options.retry.delayMinimum > 0 && options.retry.delayMinimum < this.#retry.delayMaximum)) {
				throw new RangeError(`Argument \`options.retry.delayMinimum\` must be a number which is integer, positive, safe, > 0, and < ${this.#retry.delayMaximum}!`);
			}
			this.#retry.delayMinimum = options.retry.delayMinimum;
		} else if (typeof options.retry.delayMinimum !== "undefined") {
			throw new TypeError(`Argument \`options.retry.delayMinimum\` must be type of number or undefined!`);
		}
		if (typeof options.retry.jitter === "number" && !Number.isNaN(options.retry.jitter)) {
			if (!(options.retry.jitter >= 0 && options.retry.jitter <= 1)) {
				throw new RangeError(`Argument \`options.retry.jitter\` must be a number which is between 0 and 1!`);
			}
			this.#retry.jitter = options.retry.jitter;
		} else if (typeof options.retry.jitter !== "undefined") {
			throw new TypeError(`Argument \`options.retry.jitter\` must be type of number or undefined!`);
		}
		if (typeof options.timeout === "number" && !Number.isNaN(options.timeout)) {
			if (options.timeout !== Infinity && !(Number.isSafeInteger(options.timeout) && options.timeout > 0)) {
				throw new RangeError(`Argument \`options.timeout\` must be a number which is integer, positive, safe, and > 0!`);
			}
			this.#timeout = options.timeout;
		} else if (typeof options.timeout !== "undefined") {
			throw new TypeError(`Argument \`options.timeout\` must be type of number or undefined!`);
		}
	}
	/**
	 * Fetch a resource from the network with retry attempts.
	 * @param {Exclude<Parameters<typeof fetch>[0], Request>} input URL of the resource.
	 * @param {Parameters<typeof fetch>[1]} [init] Custom setting that apply to the request.
	 * @returns {Promise<Response>} Response.
	 */
	async fetch(input: Exclude<Parameters<typeof fetch>[0], Request>, init?: Parameters<typeof fetch>[1]): Promise<Response> {
		let signal: AbortSignal | undefined = init?.signal ?? undefined;// `undefined` is necessary to omit `null`.
		if (this.#timeout !== Infinity) {
			signal ??= AbortSignal.timeout(this.#timeout);
		}
		let attempt = 0;
		let response: Response;
		do {
			response = await fetch(input, { ...init, signal });
			let retryable: boolean = statusCodeRetryable.has(response.status);
			if (typeof this.#retry.condition === "function") {
				if (!this.#retry.condition(response.status, retryable)) {
					break;
				}
			} else {
				if (!retryable) {
					break;
				}
			}
			if (attempt >= this.#retry.attempts) {
				break;
			}
			let delayTime: number;
			for (let headerName of ["Retry-After", "x-ratelimit-reset"]) {
				let value: string | null = response.headers.get(headerName);
				if (typeof value === "string") {
					if (/^[1-9]\d*$/u.test(value)) {
						delayTime ??= Number(value) * 1000;
					} else {
						try {
							delayTime ??= Date.parse(value) - Date.now();
						} catch { }
					}
				}
			}
			delayTime ??= exponentialBackoffWithJitter({
				attempt: this.#retry.attempts,
				base: this.#retry.delayMinimum,
				cap: this.#retry.delayMaximum,
				jitter: this.#retry.jitter,
				multiplier: this.#retry.backoffMultiplier
			});
			delayTime = Math.max(1000, delayTime);
			let eventRetryPayload: ExFetchEventOnRetryPayload = {
				attemptCurrent: attempt + 1,
				attempts: this.#retry.attempts,
				retryAfter: delayTime,
				statusCode: response.status,
				statusText: response.statusText
			};
			this.#event?.emit("retry", eventRetryPayload);
			await delay(delayTime, { signal });
			attempt += 1;
		} while (attempt <= this.#retry.attempts);
		return response;
	}
	/**
	 * Fetch paginate resources from the network with retry attempts; Not support GraphQL.
	 * @param {Exclude<Parameters<typeof fetch>[0], Request>} input URL of the first page of the resources.
	 * @param {Parameters<typeof fetch>[1]} init Custom setting that apply to each request.
	 * @param {ExFetchPaginateOptions} [optionsOverride={}] Options.
	 * @returns {Promise<Response[]>} Responses.
	 */
	async fetchPaginate(input: Exclude<Parameters<typeof fetch>[0], Request>, init?: Parameters<typeof fetch>[1], optionsOverride: ExFetchPaginateOptions = {}): Promise<Response[]> {
		this.#checkPaginateOptions(optionsOverride, "optionsOverride");
		let optionsResolve: ExFetchPaginateOptionsBase = { ...this.#paginate, ...optionsOverride };
		let signal: AbortSignal | undefined = init?.signal ?? undefined;// `undefined` is necessary to omit `null`.
		if (this.#timeout !== Infinity) {
			signal ??= AbortSignal.timeout(this.#timeout);
		}
		let responses: Response[] = [];
		for (let page = 1, uri: URL | undefined = new URL(input); page <= optionsResolve.count && uri instanceof URL; page += 1) {
			if (page > 1 && optionsResolve.pause > 0) {
				await delay(optionsResolve.pause, { signal });
			}
			let uriLookUp: URL = uri;
			uri = undefined;
			let response: Response = await this.fetch(uriLookUp, { ...init, signal });
			responses.push(response);
			if (response.ok) {
				try {
					let responseHeaderLink: HTTPHeaderLink = HTTPHeaderLink.parse(response);
					if (typeof optionsResolve.linkUpNextPage === "function") {
						uri = optionsResolve.linkUpNextPage(uriLookUp, responseHeaderLink);
					} else {
						uri = new URL(responseHeaderLink.getByRel("next")[0][0], uriLookUp);
					}
				} catch (error) {
					if (optionsResolve.throwOnInvalidHeaderLink) {
						throw new SyntaxError(`[${uriLookUp.toString()}] ${error?.message ?? error}`);
					}
				}
			}
		}
		return responses;
	}
	/**
	 * Fetch a resource from the network with retry attempts.
	 * @param {Exclude<Parameters<typeof fetch>[0], Request>} input URL of the resource.
	 * @param {Parameters<typeof fetch>[1]} init Custom setting that apply to the request.
	 * @param {ExFetchOptions} [options={}] Options.
	 * @returns {Promise<Response>} Response.
	 */
	static fetch(input: Exclude<Parameters<typeof fetch>[0], Request>, init?: Parameters<typeof fetch>[1], options: ExFetchOptions = {}): Promise<Response> {
		return new this(options).fetch(input, init);
	}
	/**
	 * Fetch paginate resources from the network with retry attempts; Not support GraphQL.
	 * @param {Exclude<Parameters<typeof fetch>[0], Request>} input URL of the first page of the resources.
	 * @param {Parameters<typeof fetch>[1]} init Custom setting that apply to each request.
	 * @param {ExFetchOptions} [options={}] Options.
	 * @returns {Promise<Response[]>} Responses.
	 */
	static fetchPaginate(input: Exclude<Parameters<typeof fetch>[0], Request>, init?: Parameters<typeof fetch>[1], options: ExFetchOptions = {}): Promise<Response[]> {
		return new this(options).fetchPaginate(input, init);
	}
}
export default ExFetch;
/**
 * Fetch a resource from the network with retry attempts.
 * @param {Exclude<Parameters<typeof fetch>[0], Request>} input URL of the resource.
 * @param {Parameters<typeof fetch>[1]} init Custom setting that apply to the request.
 * @param {ExFetchOptions} [options={}] Options.
 * @returns {Promise<Response>} Response.
 */
export function exFetch(input: Exclude<Parameters<typeof fetch>[0], Request>, init?: Parameters<typeof fetch>[1], options: ExFetchOptions = {}): Promise<Response> {
	return new ExFetch(options).fetch(input, init);
}
/**
 * Fetch paginate resources from the network with retry attempts; Not support GraphQL.
 * @param {Exclude<Parameters<typeof fetch>[0], Request>} input URL of the first page of the resources.
 * @param {Parameters<typeof fetch>[1]} init Custom setting that apply to each request.
 * @param {ExFetchOptions} [options={}] Options.
 * @returns {Promise<Response[]>} Responses.
 */
export function exFetchPaginate(input: Exclude<Parameters<typeof fetch>[0], Request>, init?: Parameters<typeof fetch>[1], options: ExFetchOptions = {}): Promise<Response[]> {
	return new ExFetch(options).fetchPaginate(input, init);
}
