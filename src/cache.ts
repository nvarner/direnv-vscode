import vscode from 'vscode'
import * as environment from './environment'
import { EnvironmentDiff } from './environment'

/**
 * Workspace cache. We get a separate cache per VS Code workspace, and the cache
 * persists between different VS Code sessions in the same workspace.
 */
export class Cache {
	/**
	 * The cache entry has type {@link EnvironmentDiffCache}.
	 */
	private static readonly ENVIRONMENT_DIFF_KEY = 'direnv.environmentDiff'

	/**
	 * The cache entry has type `string`.
	 */
	private static readonly CWD_OVERRIDE_KEY = 'direnv.cwdOverride'

	/**
	 * Create a cache.
	 *
	 * @param cacheProvider This should be the workspace cache provided by
	 * VS Code, `context.workspaceState`.
	 */
	constructor(private cacheProvider: vscode.Memento) {}

	/**
	 * An optional path to a directory to run direnv in. If not set, we fall
	 * back to a default.
	 */
	public get cwdOverride(): string | undefined {
		return this.cacheProvider.get(Cache.CWD_OVERRIDE_KEY)
	}

	public async setCwdOverride(cwdOverride: string | undefined) {
		await this.cacheProvider.update(Cache.CWD_OVERRIDE_KEY, cwdOverride)
	}

	/**
	 * Cached environment diff from the initial to the final environment.
	 */
	public get environmentDiff(): EnvironmentDiff | undefined {
		const entries = this.cacheProvider.get<EnvironmentDiffCache>(
			Cache.ENVIRONMENT_DIFF_KEY,
		)
		if (!Array.isArray(entries)) return
		return new Map(entries)
	}

	/**
	 * Cache the environment diff from the initial to the current environment.
	 * @param diff The diff to cache
	 */
	public async setEnvironmentDiff(diff: EnvironmentDiff) {
		const entries: EnvironmentDiffCache = [...diff.entries()]
		await this.cacheProvider.update(Cache.ENVIRONMENT_DIFF_KEY, entries)
	}

	public async clear() {
		await this.cacheProvider.update(Cache.ENVIRONMENT_DIFF_KEY, undefined)
		await this.cacheProvider.update(Cache.CWD_OVERRIDE_KEY, undefined)
	}
}

/**
 * Like {@link EnvironmentDiff}, but JSON serializable. This is required for
 * values stored in a {@link vscode.Memento}.
 */
type EnvironmentDiffCache = [environment.Variable, environment.ValueDiff][]
