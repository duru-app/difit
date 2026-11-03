import { join, resolve } from 'path';

import { simpleGit, type SimpleGit } from 'simple-git';

import { DiffMode, type WatchEvent } from '../types/watch.js';

interface FileWatcherConfig {
  watchPath: string;
  diffMode: DiffMode;
  debounceMs: number;
  onCacheInvalidate?: () => void;
}

interface ModeWatchConfig {
  watchPaths: string[];
  ignore: string[];
}

const MODE_WATCH_CONFIGS: Record<DiffMode, ModeWatchConfig> = {
  [DiffMode.DEFAULT]: {
    watchPaths: ['.git'],
    ignore: ['.git/objects/**', '.git/refs/**', 'node_modules/**'],
  },
  [DiffMode.WORKING]: {
    watchPaths: ['.', '.git'],
    ignore: ['.git/objects/**', '.git/refs/**', 'node_modules/**'],
  },
  [DiffMode.STAGED]: {
    watchPaths: ['.git'],
    ignore: ['.git/objects/**', '.git/refs/**'],
  },
  [DiffMode.DOT]: {
    watchPaths: ['.', '.git'],
    ignore: [
      '.git/objects/**',
      '.git/refs/**',
      '.git/FETCH_HEAD',
      '.git/ORIG_HEAD',
      '.git/logs/**',
      'node_modules/**',
    ],
  },
  [DiffMode.SPECIFIC]: {
    watchPaths: ['.git'],
    ignore: ['.git/objects/**', '.git/refs/**'],
  },
};

export interface WatchClient {
  send(message: string): void;
}

export class FileWatcherService {
  private subscriptions: Array<{ unsubscribe: () => Promise<void> }> = [];
  private clients: WatchClient[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingReload = false;
  private pendingHeadMove = false;
  private config: FileWatcherConfig | null = null;
  private git: SimpleGit | null = null;

  constructor() {}

  async start(
    diffMode: DiffMode,
    watchPath: string,
    debounceMs = 300,
    onCacheInvalidate?: () => void,
  ): Promise<void> {
    this.config = { watchPath, diffMode, debounceMs, onCacheInvalidate };

    // Stop existing watchers
    await this.stop();

    const modeConfig = MODE_WATCH_CONFIGS[diffMode];

    // Initialize git instance for .gitignore checking
    this.git = simpleGit(watchPath);

    try {
      await this.setupWatchers(modeConfig, watchPath);
    } catch (error) {
      console.error('❌ Failed to start file watcher:', error);
      throw error;
    }
  }

  private async setupWatchers(modeConfig: ModeWatchConfig, basePath: string): Promise<void> {
    // Loaded lazily so environments without a native @parcel/watcher binding
    // (e.g. an unsupported platform) degrade to no live reload instead of
    // failing at module load time.
    const { subscribe } = await import('@parcel/watcher');

    for (const watchPath of modeConfig.watchPaths) {
      let fullPath = join(basePath, watchPath);

      // Resolve git worktree path for .git directory
      if (watchPath === '.git') {
        fullPath = await this.resolveGitDir(basePath);
      }

      const headPaths = new Set([join(fullPath, 'HEAD'), join(fullPath, 'logs', 'HEAD')]);
      try {
        const subscription = (await subscribe(
          fullPath,
          async (err, events) => {
            if (err) {
              console.error(`Watch error for ${watchPath}:`, err);
              return;
            }

            // Filter out ignored files and check for relevant changes
            const relevantEvents = [];
            let headMoved = false;
            for (const event of events) {
              if (this.shouldIgnoreEvent(event.path, modeConfig.ignore)) {
                continue;
              }

              // For working directory watching, also apply .gitignore patterns
              if (watchPath === '.' && (await this.isGitignored(event.path, basePath))) {
                continue;
              }

              // For git directory watching, only care about specific files
              if (watchPath === '.git') {
                if (headPaths.has(event.path)) headMoved = true;
                const fileName = event.path.replace(/.*[/\\]/, '');
                const isRelevantGitFile = this.isRelevantGitFile(fileName, this.config?.diffMode);
                if (!isRelevantGitFile) {
                  continue;
                }
              }

              relevantEvents.push(event);
            }

            if (relevantEvents.length > 0 || headMoved) {
              this.debouncedBroadcast(relevantEvents.length > 0, headMoved);
            }
          },
          {
            ignore: modeConfig.ignore,
          },
        )) as { unsubscribe: () => Promise<void> };

        this.subscriptions.push(subscription);
      } catch (error) {
        console.warn(`⚠️  Could not watch ${fullPath}:`, error);
        // Continue with other watchers even if one fails
      }
    }
  }

  /**
   * Resolve the actual git directory path, handling git worktrees.
   * Uses git rev-parse --git-dir which correctly handles both normal repos and worktrees.
   */
  private async resolveGitDir(basePath: string): Promise<string> {
    try {
      const git = simpleGit(basePath);
      const gitDir = await git.revparse(['--git-dir']);
      return resolve(basePath, gitDir.trim());
    } catch {
      // Fallback to default .git path
      return join(basePath, '.git');
    }
  }

  private shouldIgnoreEvent(filePath: string, ignorePatterns: string[]): boolean {
    return ignorePatterns.some((pattern) => {
      // Handle negation patterns (e.g., "!.git/index")
      if (pattern.startsWith('!')) {
        const positivePattern = pattern.slice(1);
        return !this.matchesPattern(filePath, positivePattern);
      }
      return this.matchesPattern(filePath, pattern);
    });
  }

  private matchesPattern(filePath: string, pattern: string): boolean {
    // Simple glob pattern matching
    const regex = pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
    return new RegExp(regex).test(filePath);
  }

  private isRelevantGitFile(fileName: string, diffMode?: DiffMode): boolean {
    if (!diffMode) return false;

    switch (diffMode) {
      case DiffMode.DEFAULT:
      case DiffMode.DOT:
        return fileName === 'HEAD';
      case DiffMode.WORKING:
      case DiffMode.STAGED:
        return fileName === 'index' || fileName === 'HEAD';
      default:
        return false;
    }
  }

  private debouncedBroadcast(reload: boolean, headMove: boolean): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.pendingReload ||= reload;
    this.pendingHeadMove ||= headMove;

    const debounceMs = this.config?.debounceMs || 300;
    this.debounceTimer = setTimeout(() => {
      const { pendingReload, pendingHeadMove } = this;
      this.pendingReload = false;
      this.pendingHeadMove = false;
      if (pendingReload) {
        // Invalidate cache before broadcasting change
        if (this.config?.onCacheInvalidate) {
          this.config.onCacheInvalidate();
        }
        this.broadcastChange();
      }
      if (pendingHeadMove) {
        this.broadcast({ type: 'headMoved', timestamp: new Date().toISOString() });
      }
    }, debounceMs);
  }

  async stop(): Promise<void> {
    // Clear debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingReload = false;
    this.pendingHeadMove = false;

    // Unsubscribe from all watchers
    await Promise.all(
      this.subscriptions.map(async (subscription) => {
        try {
          await subscription.unsubscribe();
        } catch (error) {
          console.warn('Error unsubscribing from file watcher:', error);
        }
      }),
    );
    this.subscriptions = [];

    // Clear clients
    this.clients = [];
  }

  addClient(client: WatchClient, backlog: WatchEvent[] = []): void {
    this.clients.push(client);

    // Send initial connection event
    this.sendToClient(client, {
      type: 'connected',
      diffMode: this.config?.diffMode || DiffMode.DEFAULT,
      changeType: 'file',
      timestamp: new Date().toISOString(),
      message: `Connected to file watcher (${this.config?.diffMode} mode)`,
    });
    for (const event of backlog) this.sendToClient(client, event);
  }

  removeClient(client: WatchClient): void {
    const index = this.clients.indexOf(client);
    if (index > -1) {
      this.clients.splice(index, 1);
    }
  }

  broadcast(event: WatchEvent): void {
    if (this.clients.length === 0) {
      return;
    }
    this.clients.forEach((client) => {
      this.sendToClient(client, event);
    });
  }

  private broadcastChange(): void {
    if (this.clients.length === 0 || !this.config) {
      return;
    }

    const changeType = this.determineChangeType();
    const event: WatchEvent = {
      type: 'reload' as const,
      diffMode: this.config.diffMode,
      changeType,
      timestamp: new Date().toISOString(),
      message: `Changes detected in ${this.config.diffMode} mode`,
    };

    this.broadcast(event);
  }

  private sendToClient(client: WatchClient, event: unknown): void {
    try {
      client.send(JSON.stringify(event));
    } catch (error) {
      console.error('Failed to send event to client:', error);
      this.removeClient(client);
    }
  }

  private determineChangeType(): 'file' | 'commit' | 'staging' {
    if (!this.config) return 'file';

    switch (this.config.diffMode) {
      case DiffMode.DEFAULT:
      case DiffMode.DOT:
        return 'commit'; // .git/HEAD changes indicate new commits
      case DiffMode.STAGED:
        return 'staging'; // .git/index changes
      case DiffMode.WORKING:
        return 'file'; // Both file and staging changes, default to file
      default:
        return 'file';
    }
  }

  private async isGitignored(filePath: string, basePath: string): Promise<boolean> {
    if (!this.git) return false;

    // Get relative path from base directory
    const relativePath = filePath.replace(basePath + '/', '');

    try {
      const result = await this.git.checkIgnore([relativePath]);
      return result.length > 0;
    } catch {
      // checkIgnore throws an error when no files are ignored
      return false;
    }
  }
}
