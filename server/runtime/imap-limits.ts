import { isIP } from "node:net";

/**
 * In-memory abuse limits for the IMAP listener. They hold per-instance state only: a
 * deployment with several instances enforces each limit per instance. Every structure
 * is bounded (entries expire and the key count is capped), unlike the fixed-window
 * limiter in misc.ts, which never forgets a key.
 */

/** Events per key within a sliding window, e.g. authentication failures per IP. */
export class SlidingWindowCounter {
	private readonly events = new Map<string, number[]>();

	constructor(
		private readonly limit: number,
		private readonly windowMs: number,
		private readonly maxKeys = 100_000,
		private readonly now: () => number = Date.now,
	) {}

	private recent(key: string): number[] {
		const list = this.events.get(key);
		if (!list) return [];
		const cutoff = this.now() - this.windowMs;
		const kept = list.filter((time) => time > cutoff);
		if (kept.length) this.events.set(key, kept);
		else this.events.delete(key);
		return kept;
	}

	count(key: string): number {
		return this.recent(key).length;
	}

	exceeded(key: string): boolean {
		return this.count(key) >= this.limit;
	}

	hit(key: string): void {
		const list = this.recent(key);
		list.push(this.now());
		// Only the newest `limit` events can matter for exceeded().
		if (list.length > this.limit) list.splice(0, list.length - this.limit);
		this.events.delete(key);
		this.events.set(key, list);
		while (this.events.size > this.maxKeys) this.events.delete(this.events.keys().next().value as string);
	}

	get keys(): number {
		return this.events.size;
	}
}

/** Live counts per key; a key disappears when its count returns to zero. */
export class ConcurrencyCounter {
	private readonly counts = new Map<string, number>();

	constructor(private readonly limit: number) {}

	tryAcquire(key: string): boolean {
		const current = this.counts.get(key) ?? 0;
		if (current >= this.limit) return false;
		this.counts.set(key, current + 1);
		return true;
	}

	release(key: string): void {
		const current = this.counts.get(key) ?? 0;
		if (current <= 1) this.counts.delete(key);
		else this.counts.set(key, current - 1);
	}

	get keys(): number {
		return this.counts.size;
	}
}

/** A counting semaphore, e.g. for concurrent canonical-object reads across sessions. */
export class Semaphore {
	private available: number;
	private readonly waiting: Array<() => void> = [];

	constructor(size: number) {
		this.available = size;
	}

	async acquire(): Promise<() => void> {
		if (this.available > 0) this.available -= 1;
		else await new Promise<void>((resolve) => this.waiting.push(resolve));
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.waiting.shift();
			if (next) next();
			else this.available += 1;
		};
	}

	/** Permits not held, and acquisitions still waiting for one. */
	get free(): number {
		return this.available;
	}

	get waiters(): number {
		return this.waiting.length;
	}
}

/**
 * Permits for work on message content (A5.6): at most `perUser` per user and `global` in all.
 * A request first waits for one of its user's permits and only then for a global one, so a
 * user at its limit queues behind itself without taking a global permit another user could use.
 */
export class ContentReadLimiter {
	private readonly global: Semaphore;
	/** Per-user permits, with the requests holding or waiting for one; dropped when none are left. */
	private readonly users = new Map<string, { semaphore: Semaphore; requests: number }>();

	constructor(
		global: number,
		private readonly perUser: number,
	) {
		this.global = new Semaphore(global);
	}

	async acquire(userId: string): Promise<() => void> {
		let user = this.users.get(userId);
		if (!user) this.users.set(userId, (user = { semaphore: new Semaphore(this.perUser), requests: 0 }));
		user.requests += 1;
		const releaseUser = await user.semaphore.acquire();
		const releaseGlobal = await this.global.acquire();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			releaseGlobal();
			releaseUser();
			user.requests -= 1;
			if (!user.requests) this.users.delete(userId);
		};
	}

	/** Global permits not held (for tests and diagnostics). */
	get globalFree(): number {
		return this.global.free;
	}

	/** Users with a permit held or requested. */
	get activeUsers(): number {
		return this.users.size;
	}
}

/**
 * The key a client address is limited under: an IPv4 address as is (IPv4-mapped IPv6
 * included), an IPv6 address by its /64, which is what one subscriber typically holds.
 */
export function clientAddressKey(address: string | undefined): string {
	if (!address) return "unknown";
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	if (mapped) return mapped[1];
	if (isIP(address) !== 6) return address;
	const [head, tail = ""] = address.split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const groups = address.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
	return `${groups
		.slice(0, 4)
		.map((group) => parseInt(group || "0", 16).toString(16))
		.join(":")}::/64`;
}
