export enum DiffMode {
  DEFAULT = 'default', // HEAD^ vs HEAD
  WORKING = 'working', // staged vs working
  STAGED = 'staged', // HEAD vs staged
  DOT = 'dot', // HEAD vs working (all changes)
  SPECIFIC = 'specific', // commit vs commit (no watching)
}

type WatchChangeType = 'file' | 'commit' | 'staging';

interface ConnectedWatchEvent {
  type: 'connected';
  diffMode: DiffMode;
  changeType: WatchChangeType;
  timestamp: string;
  message?: string;
}

interface ReloadWatchEvent {
  type: 'reload';
  diffMode: DiffMode;
  changeType: WatchChangeType;
  timestamp: string;
  message?: string;
}

interface ErrorWatchEvent {
  type: 'error';
  diffMode: DiffMode;
  changeType: WatchChangeType;
  timestamp: string;
  message?: string;
}

interface CommentsChangedWatchEvent {
  type: 'commentsChanged';
  version: number;
  timestamp: string;
}

// `no-java`: the commit has no Java source. `no-build-file`: it has no build.gradle,
// settings.gradle or pom.xml (or a .kts variant) at the root.
export type SymbolIndexUnavailableReason = 'no-java' | 'no-build-file' | 'no-scip-java';

// `no-gradle`: scip-java could not run `gradle` because the commit has no gradlew and none is on
// PATH. `exit-code`: scip-java ended with another failure. `no-output`: it ended without writing
// an index.
export type SymbolIndexFailure = 'no-gradle' | 'timeout' | 'exit-code' | 'no-output' | 'error';

export type SymbolIndexState =
  | { status: 'none' }
  // `after` is the full sha of the commit whose build runs right before this one.
  | { status: 'queued'; after: string }
  // Milliseconds since the epoch.
  | { status: 'building'; startedAt: number }
  // `withoutRelations`: only an index stored before implementations and callers were kept is
  // there.
  | { status: 'ready'; withoutRelations?: true }
  | { status: 'unavailable'; reason: SymbolIndexUnavailableReason }
  | {
      status: 'failed';
      reason: SymbolIndexFailure;
      exitCode?: number | null;
      // What went wrong, in English, as the last line of the build log says it.
      detail: string;
      hasLog: boolean;
    };

interface SymbolIndexChangedWatchEvent {
  type: 'symbolIndexChanged';
  // Full commit sha.
  commit: string;
  state: SymbolIndexState;
  timestamp: string;
}

export type WatchEvent =
  | ConnectedWatchEvent
  | ReloadWatchEvent
  | ErrorWatchEvent
  | CommentsChangedWatchEvent
  | SymbolIndexChangedWatchEvent;

export interface ClientWatchState {
  isWatchEnabled: boolean;
  diffMode: DiffMode;
  shouldReload: boolean;
  isReloading: boolean;
  lastChangeTime: Date | null;
  lastChangeType: WatchChangeType | null;
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting';
}
