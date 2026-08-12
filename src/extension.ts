import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as cp from "child_process";




/** Represents one tracked project entry in the shared JSON file. */
interface ProjectEntry {
  /** Absolute filesystem path to the workspace folder. */
  absolutePath: string;
  /** Human-readable display name (typically the folder basename). */
  displayName: string;
  /** Unix-epoch millisecond timestamp of the last heartbeat from that window. */
  lastSeen: number;
  /** Git branch name if this is a repository */
  gitBranch?: string;
  /** True if the repository has uncommitted changes */
  gitDirty?: boolean;
  /** True if another instance requested this project to close */
  closeRequested?: boolean;
  /** The detected primary language extension of the project (e.g. ts, java) */
  language?: string;
}

function detectProjectLanguage(dir: string): string | undefined {
  try {
    const files = fs.readdirSync(dir);
    if (files.includes("pom.xml") || files.includes("build.gradle")) return "java";
    if (files.includes("tsconfig.json")) return "ts";
    if (files.includes("package.json")) return "js";
    if (files.includes("requirements.txt") || files.includes("pyproject.toml") || files.includes("Pipfile")) return "py";
    if (files.includes("go.mod")) return "go";
    if (files.includes("Cargo.toml")) return "rs";
    if (files.some(f => f.endsWith(".sln") || f.endsWith(".csproj"))) return "cs";
    if (files.includes("composer.json")) return "php";
    if (files.includes("Gemfile")) return "rb";
    if (files.includes("CMakeLists.txt")) return "cpp";
    if (files.includes("Makefile") && files.some(f => f.endsWith(".c") || f.endsWith(".cpp"))) return "c";
    if (files.includes("pubspec.yaml")) return "dart";
    if (files.includes("mix.exs")) return "ex";
    if (files.includes("build.sbt")) return "scala";
    if (files.includes("main.go")) return "go";
  } catch {
  }
  return undefined;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Filename for the shared state that every window reads/writes. */
const STATE_FILE = "opened_projects.json";

/** Filename for the historical list of recently opened projects. */
const RECENT_FILE = "recent_projects.json";

/**
 * If a project hasn't sent a heartbeat within this many milliseconds it is
 * considered stale and will be pruned from the list.
 *
 * 30 seconds is generous — the heartbeat interval is 10 s, so a window would
 * need to miss 3 consecutive heartbeats before being cleaned up.
 */
const STALE_THRESHOLD_MS = 30_000;

/** How often each window writes its "I'm alive" timestamp. */
const HEARTBEAT_INTERVAL_MS = 10_000;

// ─── Module-level state ──────────────────────────────────────────────────────

let statusBarItem: vscode.StatusBarItem;
let heartbeatTimer: NodeJS.Timeout | undefined;
let stateFilePath: string;
let recentFilePath: string;
let projectTreeProvider: ProjectTreeDataProvider;
let recentProjectTreeProvider: RecentProjectTreeDataProvider;
let discoveredProjectTreeProvider: DiscoveredProjectTreeDataProvider;
let ignoredProjectTreeProvider: IgnoredProjectTreeDataProvider;

let closeCheckTimer: NodeJS.Timeout | undefined;

let sidebarTreeView: vscode.TreeView<vscode.TreeItem>;
let panelTreeView: vscode.TreeView<vscode.TreeItem>;
let recentSidebarTreeView: vscode.TreeView<vscode.TreeItem>;
let recentPanelTreeView: vscode.TreeView<vscode.TreeItem>;

// Tag Filtering State
let activeTagFilters: string[] | undefined = undefined;

let cachedDiscoveredProjects: ProjectEntry[] = [];

/**
 * Dynamically created status bar items — one per open project.
 * Only populated when `displayMode` is `"statusBar"`.
 */
let dynamicStatusBarItems: vscode.StatusBarItem[] = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Ensures the directory for `stateFilePath` exists, creating it recursively
 * if necessary.  `globalStorageUri` is *not* guaranteed to exist on first run.
 */
function ensureStorageDir(): void {
  const dir = path.dirname(stateFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Reads the shared JSON state file and returns the list of project entries.
 * Returns an empty array if the file doesn't exist or is corrupt.
 */
function readState(): ProjectEntry[] {
  try {
    if (!fs.existsSync(stateFilePath)) {
      return [];
    }
    const raw = fs.readFileSync(stateFilePath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // File is missing, empty, or malformed — start fresh.
    return [];
  }
}

/**
 * Atomically writes the project list back to the shared JSON state file.
 * Uses write-to-temp-then-rename to avoid partial reads by other windows.
 */
function writeState(entries: ProjectEntry[]): void {
  ensureStorageDir();
  const tmp = stateFilePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf-8");
  fs.renameSync(tmp, stateFilePath);
}

/** Reads the shared recent projects list. */
function readRecentState(): ProjectEntry[] {
  try {
    if (!fs.existsSync(recentFilePath)) return [];
    const raw = fs.readFileSync(recentFilePath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Atomically writes the recent projects list. */
function writeRecentState(entries: ProjectEntry[]): void {
  ensureStorageDir();
  const tmp = recentFilePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf-8");
  fs.renameSync(tmp, recentFilePath);
}

/**
 * Returns the workspace folder path for the current window, or `undefined`
 * if no folder is open (e.g. an untitled window).
 */
function getWorkspacePath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return undefined;
}

/**
 * Returns a human-friendly name for the current workspace.
 * Falls back to the folder basename when `workspace.name` isn't available.
 */
function getWorkspaceName(): string {
  if (vscode.workspace.name) {
    return vscode.workspace.name;
  }
  const wsPath = getWorkspacePath();
  return wsPath ? path.basename(wsPath) : "Unknown";
}

/**
 * Removes entries whose `lastSeen` timestamp is older than the stale
 * threshold.  Entries that haven't heartbeated are pruned because the
 * owning window is likely closed.
 */
function pruneStaleEntries(entries: ProjectEntry[]): ProjectEntry[] {
  const now = Date.now();
  return entries.filter((entry) => {
    const age = now - entry.lastSeen;
    // Keep the entry if its heartbeat is recent enough.
    if (age < STALE_THRESHOLD_MS) {
      return true;
    }
    // Stale — discard regardless of whether the directory still exists,
    // because the window that owned it is no longer alive.
    return false;
  });
}

/**
 * Returns a fresh, pruned, alphabetically sorted list of project entries.
 * Used by both the QuickPick and TreeView paths.
 */
function getFreshEntries(): ProjectEntry[] {
  let entries = pruneStaleEntries(readState());
  const config = vscode.workspace.getConfiguration("smartProjects");
  const ignoredProjects = config.get<string[]>("ignoredProjects", []);
  
  entries = entries.filter(p => !ignoredProjects.includes(p.absolutePath));
  
  const pinned = getPinnedProjects();
  
  entries.sort((a, b) => {
    const aTags = getProjectTags(a.absolutePath);
    const bTags = getProjectTags(b.absolutePath);
    const aTag = aTags.length > 0 ? aTags[0] : undefined;
    const bTag = bTags.length > 0 ? bTags[0] : undefined;
    
    // Sort untagged items before tagged groups
    if (aTag && !bTag) return 1;
    if (!aTag && bTag) return -1;
    // Sort groups alphabetically
    if (aTag && bTag && aTag !== bTag) return aTag.localeCompare(bTag);
    
    // Within the same group (or both untagged), sort pinned first
    const aPinned = pinned.includes(a.absolutePath);
    const bPinned = pinned.includes(b.absolutePath);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    
    return a.displayName.localeCompare(b.displayName);
  });
  
  return entries;
}

/**
 * Returns the tag for a given project.
 */
function getProjectTags(absolutePath: string): string[] {
  const config = vscode.workspace.getConfiguration("smartProjects");
  const tags = config.get<Record<string, string[] | string>>("projectTags", {});
  const tagVal = tags[absolutePath];
  if (Array.isArray(tagVal)) return tagVal;
  if (typeof tagVal === "string" && tagVal.trim() !== "") return [tagVal];
  return [];
}

/**
 * Sets or removes the tags for a project.
 */
async function setProjectTags(absolutePath: string, projectTags: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration("smartProjects");
  const tags = { ...config.get<Record<string, string[] | string>>("projectTags", {}) };
  
  if (!projectTags || projectTags.length === 0) {
    delete tags[absolutePath];
  } else {
    tags[absolutePath] = projectTags;
  }
  
  await config.update("projectTags", tags, vscode.ConfigurationTarget.Global);
  
  projectTreeProvider?.refresh();
  recentProjectTreeProvider?.refresh();
  if (getDisplayMode() === "statusBar") {
    syncStatusBarItems();
  }
}

/**
 * Returns a list of recently opened projects, sorted by most recent first,
 * capped at 20 items, and filtering out any that are currently open.
 */
function getFreshRecentEntries(): ProjectEntry[] {
  const currentOpen = getFreshEntries().map((e) => e.absolutePath);
  let recent = readRecentState();
  
  const config = vscode.workspace.getConfiguration("smartProjects");
  const ignoredProjects = config.get<string[]>("ignoredProjects", []);
  
  // Sort by most recently seen
  recent.sort((a, b) => b.lastSeen - a.lastSeen);
  
  // Remove duplicates and currently open projects
  const seenPaths = new Set<string>();
  recent = recent.filter((entry) => {
    if (ignoredProjects.includes(entry.absolutePath) || currentOpen.includes(entry.absolutePath) || seenPaths.has(entry.absolutePath)) {
      return false;
    }
    seenPaths.add(entry.absolutePath);
    return true;
  });

  let top20 = recent.slice(0, 20);
  
  top20.sort((a, b) => {
    const aTags = getProjectTags(a.absolutePath);
    const bTags = getProjectTags(b.absolutePath);
    const aTag = aTags.length > 0 ? aTags[0] : undefined;
    const bTag = bTags.length > 0 ? bTags[0] : undefined;
    
    if (aTag && !bTag) return 1;
    if (!aTag && bTag) return -1;
    if (aTag && bTag && aTag !== bTag) return aTag.localeCompare(bTag);
    
    return b.lastSeen - a.lastSeen;
  });

  return top20;
}

/**
 * Recursively scans directories up to maxDepth looking for projects (.git or package.json).
 */
async function scanForProjects(dirs: string[], maxDepth = 3): Promise<ProjectEntry[]> {
  const results: ProjectEntry[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      let isProject = false;
      
      for (const e of entries) {
        if (e.name === ".git" || e.name === "package.json" || e.name === "pom.xml" || e.name === ".vscode") {
          isProject = true;
          break;
        }
      }

      if (isProject) {
        results.push({
          absolutePath: dir,
          displayName: path.basename(dir),
          lastSeen: 0,
          language: detectProjectLanguage(dir)
        });
        return;
      }

      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
          await walk(path.join(dir, e.name), depth + 1);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  for (const dir of dirs) {
    const resolved = dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
    await walk(resolved, 1);
  }
  
  results.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return results;
}

/**
 * Updates the in-memory cache of discovered projects and signals the UI to refresh.
 */
async function updateDiscoveredProjectsCache(): Promise<void> {
  const config = vscode.workspace.getConfiguration("smartProjects");
  const dirs = config.get<string[]>("scanDirectories", []);
  
  if (dirs.length === 0) {
    cachedDiscoveredProjects = [];
  } else {
    cachedDiscoveredProjects = await scanForProjects(dirs);
  }

  vscode.commands.executeCommand("setContext", "smartProjects:hasScanDirectories", dirs.length > 0);
  discoveredProjectTreeProvider?.refresh();
}

/**
 * Returns discovered projects that are neither currently open nor in the recent list.
 */
function getFreshDiscoveredEntries(): ProjectEntry[] {
  const open = getFreshEntries().map(e => e.absolutePath);
  const recent = getFreshRecentEntries().map(e => e.absolutePath);
  
  const config = vscode.workspace.getConfiguration("smartProjects");
  const ignoredProjects = config.get<string[]>("ignoredProjects", []);

  let filtered = cachedDiscoveredProjects.filter(e => !ignoredProjects.includes(e.absolutePath) && !open.includes(e.absolutePath) && !recent.includes(e.absolutePath));
  
  const pinned = getPinnedProjects();
  
  filtered.sort((a, b) => {
    const aTags = getProjectTags(a.absolutePath);
    const bTags = getProjectTags(b.absolutePath);
    const aTag = aTags.length > 0 ? aTags[0] : undefined;
    const bTag = bTags.length > 0 ? bTags[0] : undefined;
    
    if (aTag && !bTag) return 1;
    if (!aTag && bTag) return -1;
    if (aTag && bTag && aTag !== bTag) return aTag.localeCompare(bTag);
    
    const aPinned = pinned.includes(a.absolutePath);
    const bPinned = pinned.includes(b.absolutePath);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    
    return a.displayName.localeCompare(b.displayName);
  });
  
  return filtered;
}

/**
 * Returns the list of pinned project absolute paths.
 */
function getPinnedProjects(): string[] {
  const config = vscode.workspace.getConfiguration("smartProjects");
  return config.get<string[]>("pinnedProjects", []);
}

/**
 * Toggles the pinned state of a project.
 */
async function togglePin(absolutePath: string, pin: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration("smartProjects");
  let pinned = getPinnedProjects();
  
  if (pin && !pinned.includes(absolutePath)) {
    pinned.push(absolutePath);
  } else if (!pin && pinned.includes(absolutePath)) {
    pinned = pinned.filter(p => p !== absolutePath);
  } else {
    return; // No change
  }
  
  await config.update("pinnedProjects", pinned, vscode.ConfigurationTarget.Global);
  
  projectTreeProvider?.refresh();
  recentProjectTreeProvider?.refresh();
  if (getDisplayMode() === "statusBar") {
    syncStatusBarItems();
  }
}

/**
 * Forgets a project by removing it from the state and adding it to the ignoredProjects setting.
 */
async function handleForgetProject(arg?: ProjectTreeItem | RecentProjectTreeItem): Promise<void> {
  let targetEntry: ProjectEntry | undefined;

  if (arg && 'entry' in arg) {
    targetEntry = arg.entry;
  } else {
    const entries = getFreshEntries();
    if (entries.length === 0) return;
    const items: vscode.QuickPickItem[] = entries.map((entry) => ({
      label: entry.displayName,
      description: entry.absolutePath,
    }));
    const selectedProject = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a project to forget...",
    });
    if (!selectedProject) return;
    targetEntry = entries.find((e) => e.absolutePath === selectedProject.description);
  }

  if (!targetEntry) return;

  const config = vscode.workspace.getConfiguration("smartProjects");
  const ignoredProjects = config.get<string[]>("ignoredProjects", []);
  
  if (!ignoredProjects.includes(targetEntry.absolutePath)) {
    ignoredProjects.push(targetEntry.absolutePath);
    await config.update("ignoredProjects", ignoredProjects, vscode.ConfigurationTarget.Global);
  }

  const state = readState();
  const index = state.findIndex(p => p.absolutePath === targetEntry!.absolutePath);
  if (index !== -1) {
    state.splice(index, 1);
    writeState(state);
  }

  vscode.commands.executeCommand("smartProjects.refreshProjects");
  vscode.commands.executeCommand("setContext", "smartProjects:hasIgnoredProjects", true);
  vscode.window.showInformationMessage(`Forgot project: ${targetEntry.displayName}. It has been added to your ignored projects list.`);
}

/**
 * Unforgets a project by removing it from the ignoredProjects setting.
 */
async function handleUnforgetProject(arg?: IgnoredProjectTreeItem): Promise<void> {
  if (!arg) return;

  const config = vscode.workspace.getConfiguration("smartProjects");
  let ignoredProjects = config.get<string[]>("ignoredProjects", []);
  
  ignoredProjects = ignoredProjects.filter(p => p !== arg.entry.absolutePath);
  await config.update("ignoredProjects", ignoredProjects, vscode.ConfigurationTarget.Global);

  vscode.commands.executeCommand("smartProjects.refreshProjects");
  vscode.commands.executeCommand("setContext", "smartProjects:hasIgnoredProjects", ignoredProjects.length > 0);
  vscode.window.showInformationMessage(`Unforgot project: ${arg.entry.displayName}.`);
}

/**
 * Prompts the user to set a tag for a project.
 */
async function handleSetProjectTag(arg?: ProjectTreeItem | RecentProjectTreeItem | DiscoveredProjectTreeItem): Promise<void> {
  let targetEntry: ProjectEntry | undefined;

  if (arg instanceof ProjectTreeItem || arg instanceof RecentProjectTreeItem || arg instanceof DiscoveredProjectTreeItem) {
    targetEntry = arg.entry;
  } else {
    // Called from Command Palette — prompt the user to pick a project first.
    const entries = getFreshEntries();
    if (entries.length === 0) {
      vscode.window.showInformationMessage("No open projects found.");
      return;
    }
    const items: vscode.QuickPickItem[] = entries.map((entry) => ({
      label: entry.displayName,
      description: entry.absolutePath,
    }));
    const selectedProject = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a project to tag...",
    });
    if (!selectedProject) return;
    targetEntry = entries.find((e) => e.absolutePath === selectedProject.description);
  }

  if (!targetEntry) return;

  const currentTags = getProjectTags(targetEntry.absolutePath);
  
  // Collect all known tags across all projects
  const config = vscode.workspace.getConfiguration("smartProjects");
  const allTagsMap = config.get<Record<string, string[] | string>>("projectTags", {});
  const allTagsSet = new Set<string>();
  
  for (const val of Object.values(allTagsMap)) {
    if (Array.isArray(val)) {
      val.forEach(t => allTagsSet.add(t));
    } else if (typeof val === "string" && val.trim() !== "") {
      allTagsSet.add(val);
    }
  }

  const items: vscode.QuickPickItem[] = [];

  for (const tag of Array.from(allTagsSet).sort()) {
    items.push({
      label: tag,
      picked: currentTags.includes(tag)
    });
  }

  const qp = vscode.window.createQuickPick();
  qp.items = items;
  qp.canSelectMany = true;
  qp.selectedItems = items.filter(i => i.picked);
  qp.placeholder = `Select tags for ${targetEntry.displayName} (Type a new tag and press Enter to add)`;

  qp.onDidAccept(async () => {
    const selectedTags = qp.selectedItems.map(item => item.label);

    const typedText = qp.value.trim();
    if (typedText && !allTagsSet.has(typedText)) {
      // The user typed a custom tag directly into the filter box
      selectedTags.push(typedText);
    }

    qp.hide();

    await setProjectTags(targetEntry!.absolutePath, selectedTags);
    qp.dispose();
  });

  qp.onDidHide(() => {
    qp.dispose();
  });

  qp.show();
}

/**
 * Removes all tags from a project.
 */
async function handleRemoveProjectTag(arg?: ProjectTreeItem | RecentProjectTreeItem | DiscoveredProjectTreeItem): Promise<void> {
  if (arg instanceof ProjectTreeItem || arg instanceof RecentProjectTreeItem || arg instanceof DiscoveredProjectTreeItem) {
    await setProjectTags(arg.entry.absolutePath, []);
  }
}

async function handleFilterByTag(): Promise<void> {
  const config = vscode.workspace.getConfiguration("smartProjects");
  const allTagsMap = config.get<Record<string, string[] | string>>("projectTags", {});
  const allTagsSet = new Set<string>();
  
  for (const val of Object.values(allTagsMap)) {
    if (Array.isArray(val)) {
      val.forEach(t => allTagsSet.add(t));
    } else if (typeof val === "string" && val.trim() !== "") {
      allTagsSet.add(val);
    }
  }

  const items: vscode.QuickPickItem[] = [];
  
  items.push({
    label: "Untagged",
    description: "Projects with no tags",
    picked: activeTagFilters === undefined || activeTagFilters.includes("Untagged")
  });

  for (const tag of Array.from(allTagsSet).sort()) {
    items.push({
      label: tag,
      picked: activeTagFilters === undefined || activeTagFilters.includes(tag)
    });
  }

  const selectedItems = await vscode.window.showQuickPick(items, {
    placeHolder: "Select tag groups to show",
    canPickMany: true
  });

  if (!selectedItems) return;

  if (selectedItems.length === items.length) {
    activeTagFilters = undefined;
  } else {
    activeTagFilters = selectedItems.map(item => item.label);
  }

  const filterDesc = activeTagFilters ? "(Filtered)" : "";
  if (sidebarTreeView) sidebarTreeView.description = filterDesc;
  if (panelTreeView) panelTreeView.description = filterDesc;
  if (recentSidebarTreeView) recentSidebarTreeView.description = filterDesc;
  if (recentPanelTreeView) recentPanelTreeView.description = filterDesc;

  projectTreeProvider?.refresh();
  recentProjectTreeProvider?.refresh();
}

type DisplayMode = "quickPick" | "treeView" | "panel" | "statusBar" | "statusBarTags";

/**
 * Reads the user's chosen display mode from settings.
 */
function getDisplayMode(): DisplayMode {
  const config = vscode.workspace.getConfiguration("smartProjects");
  return config.get<DisplayMode>("displayMode", "quickPick");
}

// ─── Core sync operations ────────────────────────────────────────────────────

interface GitStatus {
  branch?: string;
  dirty?: boolean;
}

/**
 * Gets the current git branch and dirty status for a directory.
 */
async function getGitStatus(dir: string): Promise<GitStatus> {
  return new Promise((resolve) => {
    // 1. Get branch
    cp.execFile("git", ["branch", "--show-current"], { cwd: dir, timeout: 2000 }, (err, stdout) => {
      if (err) {
        return resolve({}); // Not a git repo or no commits yet
      }
      const branch = stdout.trim();
      
      // 2. Check if dirty
      cp.execFile("git", ["status", "--porcelain"], { cwd: dir, timeout: 2000 }, (err2, stdout2) => {
        if (err2) {
          return resolve({ branch });
        }
        const dirty = stdout2.trim().length > 0;
        resolve({ branch, dirty });
      });
    });
  });
}

/**
 * Registers (or refreshes) the current workspace in the shared state file,
 * pruning stale entries along the way.
 */
async function registerCurrentWorkspace(): Promise<void> {
  const wsPath = getWorkspacePath();
  if (!wsPath) {
    return; // No folder open — nothing to register.
  }

  const config = vscode.workspace.getConfiguration("smartProjects");
  const ignoredProjects = config.get<string[]>("ignoredProjects", []);
  if (ignoredProjects.includes(wsPath)) {
    return;
  }

  const showGit = config.get<boolean>("showGitStatus", true);
  
  let gitBranch: string | undefined;
  let gitDirty: boolean | undefined;

  if (showGit) {
    const gitStatus = await getGitStatus(wsPath);
    gitBranch = gitStatus.branch;
    gitDirty = gitStatus.dirty;
  }

  let entries = readState();

  // Prune dead entries first.
  entries = pruneStaleEntries(entries);

  const now = Date.now();
  const idx = entries.findIndex((e) => e.absolutePath === wsPath);

  if (idx !== -1 && entries[idx].closeRequested) {
    vscode.commands.executeCommand("workbench.action.closeWindow");
    return;
  }

  const language = detectProjectLanguage(wsPath);

  if (idx !== -1) {
    // Already tracked — just bump the heartbeat.
    entries[idx].lastSeen = now;
    entries[idx].displayName = getWorkspaceName();
    entries[idx].gitBranch = gitBranch;
    entries[idx].gitDirty = gitDirty;
    entries[idx].language = language;
  } else {
    // New entry.
    entries.push({
      absolutePath: wsPath,
      displayName: getWorkspaceName(),
      lastSeen: now,
      gitBranch,
      gitDirty,
      language
    });
  }

  writeState(entries);

  // ── Update recent projects list
  let recent = readRecentState();
  const recentIdx = recent.findIndex((e) => e.absolutePath === wsPath);
  if (recentIdx !== -1) {
    recent[recentIdx].lastSeen = now;
    recent[recentIdx].displayName = getWorkspaceName();
    recent[recentIdx].gitBranch = gitBranch;
    recent[recentIdx].gitDirty = gitDirty;
    recent[recentIdx].language = language;
  } else {
    recent.push({
      absolutePath: wsPath,
      displayName: getWorkspaceName(),
      lastSeen: now,
      gitBranch,
      gitDirty,
      language
    });
  }
  // Keep only the 20 most recent
  recent.sort((a, b) => b.lastSeen - a.lastSeen);
  recent = recent.slice(0, 20);
  writeRecentState(recent);

  // Refresh the tree view if it exists, so it picks up the new state.
  projectTreeProvider?.refresh();
  recentProjectTreeProvider?.refresh();

  // Refresh dynamic status bar items if that mode is active.
  if (getDisplayMode() === "statusBar") {
    syncStatusBarItems();
  }
}

/**
 * Removes the current workspace from the shared state file.
 * Called on extension deactivation so the list stays accurate.
 * Note: We deliberately leave it in the recent_projects.json file.
 */
function unregisterCurrentWorkspace(): void {
  const wsPath = getWorkspacePath();
  if (!wsPath) {
    return;
  }

  let entries = readState();
  entries = entries.filter((e) => e.absolutePath !== wsPath);
  writeState(entries);
}

// ─── Tree View ───────────────────────────────────────────────────────────────

class ProjectGroupTreeItem extends vscode.TreeItem {
  constructor(public readonly tag: string) {
    super(tag, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "projectGroup";
    this.iconPath = new vscode.ThemeIcon("tag");
  }
}


class ProjectTreeItem extends vscode.TreeItem {
  constructor(public readonly entry: ProjectEntry) {
    super(entry.displayName, vscode.TreeItemCollapsibleState.None);

    this.tooltip = entry.absolutePath;
    
    const isCurrent = entry.absolutePath === getWorkspacePath();
    const isPinned = getPinnedProjects().includes(entry.absolutePath);
    const showGit = vscode.workspace.getConfiguration("smartProjects").get<boolean>("showGitStatus", true);
    
    let desc = "";
    if (isCurrent) desc = "● current";
    if (isPinned) desc += (desc ? " " : "") + "📌";
    if (showGit && entry.gitBranch) {
      const gitStr = `[${entry.gitBranch}${entry.gitDirty ? "*" : ""}]`;
      desc += (desc ? "  " : "") + gitStr;
    }
    this.description = desc || undefined;
    
    this.contextValue = isPinned ? "smartProjectsItemPinned" : "smartProjectsItem";

    // Clicking a tree item opens the project (same as the inline button).
    this.command = {
      command: "smartProjects.openProject",
      title: "Open Project",
      arguments: [entry.absolutePath],
    };

    // Visual indicator: current project gets a filled-circle icon,
    // others get a window icon. Both get the consistent deterministic color!
    const config = vscode.workspace.getConfiguration("smartProjects");
    const useLanguageIcons = config.get<boolean>("useLanguageIcons", true);

    if (useLanguageIcons && entry.language) {
      this.resourceUri = vscode.Uri.file(path.join(entry.absolutePath, "project." + entry.language));
    } else {
      const projectColor = getProjectColor(entry.displayName, entry.absolutePath);
      const hasGit = entry.gitBranch !== undefined || fs.existsSync(path.join(entry.absolutePath, ".git"));
      this.iconPath = isCurrent
        ? new vscode.ThemeIcon("circle-filled", projectColor)
        : (hasGit ? new vscode.ThemeIcon("repo", projectColor) : new vscode.ThemeIcon("window", projectColor));
    }
  }
}

/**
 * Provides tree data for the "Open Projects" sidebar view.
 * Reads from the same shared JSON file as the QuickPick flow.
 */
class ProjectTreeDataProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  // ── Event emitter to signal the tree should re-render ────────────────
  private _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Call this to force the tree to re-read data and re-render. */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const entries = getFreshEntries();
    const currentPath = getWorkspacePath();
    const pinned = getPinnedProjects();

    if (!element) {
      // Root level
      const rootItems: vscode.TreeItem[] = [];
      const seenTags = new Set<string>();

      for (const entry of entries) {
        const tags = getProjectTags(entry.absolutePath);
        if (tags.length === 0) {
          if (!activeTagFilters || activeTagFilters.includes("Untagged")) {
            rootItems.push(new ProjectTreeItem(entry));
          }
        } else {
          for (const tag of tags) {
            if (!seenTags.has(tag)) {
              seenTags.add(tag);
              if (!activeTagFilters || activeTagFilters.includes(tag)) {
                rootItems.push(new ProjectGroupTreeItem(tag));
              }
            }
          }
        }
      }
      return rootItems;
    } else if (element instanceof ProjectGroupTreeItem) {
      // Group level
      return entries
        .filter(entry => getProjectTags(entry.absolutePath).includes(element.tag))
        .map(entry => new ProjectTreeItem(entry));
    }
    
    return [];
  }
}

// ─── Recent Projects Tree View ───────────────────────────────────────────────

class RecentProjectTreeItem extends vscode.TreeItem {
  constructor(public readonly entry: ProjectEntry) {
    super(entry.displayName, vscode.TreeItemCollapsibleState.None);

    this.tooltip = entry.absolutePath;
    
    // Relative time string for description (e.g. "2 hours ago")
    const ageMs = Date.now() - entry.lastSeen;
    let timeStr = "";
    if (ageMs < 60000) timeStr = "just now";
    else if (ageMs < 3600000) timeStr = `${Math.floor(ageMs / 60000)} mins ago`;
    else if (ageMs < 86400000) timeStr = `${Math.floor(ageMs / 3600000)} hours ago`;
    else timeStr = `${Math.floor(ageMs / 86400000)} days ago`;
    
    let desc = timeStr;
    const showGit = vscode.workspace.getConfiguration("smartProjects").get<boolean>("showGitStatus", true);
    if (showGit && entry.gitBranch) {
      const gitStr = `[${entry.gitBranch}${entry.gitDirty ? "*" : ""}]`;
      desc += `  ${gitStr}`;
    }

    this.description = desc;
    this.contextValue = "recentProjectSelectorItem";

    // Default command: open in current window
    this.command = {
      command: "smartProjects.openRecentCurrentWindow",
      title: "Open in Current Window",
      arguments: [this],
    };

    const config = vscode.workspace.getConfiguration("smartProjects");
    const useLanguageIcons = config.get<boolean>("useLanguageIcons", true);

    if (useLanguageIcons && entry.language) {
      this.resourceUri = vscode.Uri.file(path.join(entry.absolutePath, "project." + entry.language));
    } else {
      const projectColor = getProjectColor(entry.displayName, entry.absolutePath);
      const hasGit = entry.gitBranch !== undefined || fs.existsSync(path.join(entry.absolutePath, ".git"));
      this.iconPath = hasGit ? new vscode.ThemeIcon("repo", projectColor) : new vscode.ThemeIcon("history", projectColor);
    }
  }
}

class RecentProjectTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const entries = getFreshRecentEntries();
    
    if (!element) {
      const rootItems: vscode.TreeItem[] = [];
      const seenTags = new Set<string>();

      for (const entry of entries) {
        const tags = getProjectTags(entry.absolutePath);
        if (tags.length === 0) {
          if (!activeTagFilters || activeTagFilters.includes("Untagged")) {
            rootItems.push(new RecentProjectTreeItem(entry));
          }
        } else {
          for (const tag of tags) {
            if (!seenTags.has(tag)) {
              seenTags.add(tag);
              if (!activeTagFilters || activeTagFilters.includes(tag)) {
                rootItems.push(new ProjectGroupTreeItem(tag));
              }
            }
          }
        }
      }
      return rootItems;
    } else if (element instanceof ProjectGroupTreeItem) {
      return entries
        .filter(entry => getProjectTags(entry.absolutePath).includes(element.tag))
        .map(entry => new RecentProjectTreeItem(entry));
    }
    
    return [];
  }
}

// ─── Discovered Projects Tree View ───────────────────────────────────────────

class DiscoveredProjectTreeItem extends vscode.TreeItem {
  constructor(public readonly entry: ProjectEntry) {
    super(entry.displayName, vscode.TreeItemCollapsibleState.None);

    this.tooltip = entry.absolutePath;
    const isPinned = getPinnedProjects().includes(entry.absolutePath);
    const tags = getProjectTags(entry.absolutePath);
    
    let desc = "Discovered";
    if (tags.length > 0) desc += ` [${tags.join(", ")}]`;
    if (isPinned) desc += " 📌";

    this.description = desc;
    this.contextValue = isPinned ? "discoveredProjectSelectorItemPinned" : "discoveredProjectSelectorItem";

    // Default command: open in current window
    this.command = {
      command: "smartProjects.openRecentCurrentWindow", // Repurposing since it does exactly what we need
      title: "Open in Current Window",
      arguments: [this],
    };

    const config = vscode.workspace.getConfiguration("smartProjects");
    const useLanguageIcons = config.get<boolean>("useLanguageIcons", true);

    if (useLanguageIcons && entry.language) {
      this.resourceUri = vscode.Uri.file(path.join(entry.absolutePath, "project." + entry.language));
    } else {
      const projectColor = getProjectColor(entry.displayName, entry.absolutePath);
      const hasGit = entry.gitBranch !== undefined || fs.existsSync(path.join(entry.absolutePath, ".git"));
      this.iconPath = hasGit ? new vscode.ThemeIcon("repo", projectColor) : new vscode.ThemeIcon("telescope", projectColor);
    }
  }
}

class DiscoveredProjectTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) return [];
    
    const entries = getFreshDiscoveredEntries();
    return entries.map(entry => new DiscoveredProjectTreeItem(entry));
  }
}

class IgnoredProjectTreeItem extends vscode.TreeItem {
  constructor(public readonly entry: ProjectEntry) {
    super(entry.displayName, vscode.TreeItemCollapsibleState.None);

    this.tooltip = entry.absolutePath;
    this.description = "Ignored";
    this.contextValue = "ignoredProjectSelectorItem";

    const config = vscode.workspace.getConfiguration("smartProjects");
    const useLanguageIcons = config.get<boolean>("useLanguageIcons", true);

    if (useLanguageIcons && entry.language) {
      this.resourceUri = vscode.Uri.file(path.join(entry.absolutePath, "project." + entry.language));
    } else {
      const projectColor = getProjectColor(entry.displayName, entry.absolutePath);
      const hasGit = entry.gitBranch !== undefined || fs.existsSync(path.join(entry.absolutePath, ".git"));
      this.iconPath = hasGit ? new vscode.ThemeIcon("repo", projectColor) : new vscode.ThemeIcon("eye-closed", projectColor);
    }
  }
}

class IgnoredProjectTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) return [];
    
    const config = vscode.workspace.getConfiguration("smartProjects");
    const ignoredPaths = config.get<string[]>("ignoredProjects", []);
    
    // Convert paths back to entries. We might not have full ProjectEntry objects,
    // but we can fake them with just the absolutePath and deriving displayName from it.
    const pathModule = require("path");
    
    return ignoredPaths.map(p => {
      const entry: ProjectEntry = {
        absolutePath: p,
        displayName: pathModule.basename(p),
        lastSeen: 0,
        language: detectProjectLanguage(p)
      };
      return new IgnoredProjectTreeItem(entry);
    });
  }
}

// ─── QuickPick command ───────────────────────────────────────────────────────

/**
 * Shows a QuickPick dropdown listing every project currently tracked in the
 * shared state file.  Selecting an item opens that folder in a **new window**.
 */
async function showProjectPicker(filterTag?: string): Promise<void> {
  let entries = getFreshEntries();
  let recentEntries = getFreshRecentEntries();
  let discoveredEntries = getFreshDiscoveredEntries();

  if (filterTag) {
    const filterFn = (e: ProjectEntry) => {
      const tags = getProjectTags(e.absolutePath);
      return filterTag === "Untagged" ? tags.length === 0 : tags.includes(filterTag);
    };
    entries = entries.filter(filterFn);
    recentEntries = recentEntries.filter(filterFn);
    discoveredEntries = discoveredEntries.filter(filterFn);
  }

  if (entries.length === 0 && recentEntries.length === 0 && discoveredEntries.length === 0) {
    vscode.window.showInformationMessage(
      "Smart Projects: No projects found."
    );
    return;
  }

  const currentPath = getWorkspacePath();
  const pinned = getPinnedProjects();
  const showGit = vscode.workspace.getConfiguration("smartProjects").get<boolean>("showGitStatus", true);

  const items: vscode.QuickPickItem[] = [];
  let currentTag: string | undefined = undefined;

  // 1. Open Projects
  if (entries.length > 0) {
    items.push({
      label: "Open Projects",
      kind: vscode.QuickPickItemKind.Separator
    });
  }
  for (const entry of entries) {

    const isCurrent = entry.absolutePath === currentPath;
    const isPinned = pinned.includes(entry.absolutePath);
    const tags = getProjectTags(entry.absolutePath);
    const showGit = vscode.workspace.getConfiguration("smartProjects").get<boolean>("showGitStatus", true);
    
    let desc = "";
    if (tags.length > 0) desc += `[${tags.join(", ")}]`;
    if (isCurrent) desc += (desc ? " " : "") + "● current";
    if (isPinned) desc += (desc ? " " : "") + "📌";
    if (showGit && entry.gitBranch) {
      const gitStr = `[${entry.gitBranch}${entry.gitDirty ? "*" : ""}]`;
      desc += (desc ? "  " : "") + gitStr;
    }

    items.push({
      label: entry.displayName,
      description: entry.absolutePath,
      detail: desc || undefined
    });
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a project to switch to…",
    matchOnDescription: true,
  });

  if (!selected || !selected.description) {
    return;
  }

  openProjectByPath(selected.description);
}

/**
 * Unified search across all project sources (open, recent, discovered).
 * Deduplicates by path and lets the user choose to open in current or new window.
 */
async function searchAllProjects(): Promise<void> {
  const entries = getFreshEntries();
  const recentEntries = getFreshRecentEntries();
  const discoveredEntries = getFreshDiscoveredEntries();
  const currentPath = getWorkspacePath();
  const pinned = getPinnedProjects();
  const showGit = vscode.workspace.getConfiguration("smartProjects").get<boolean>("showGitStatus", true);
  const ignoredProjects = vscode.workspace.getConfiguration("smartProjects").get<string[]>("ignoredProjects", []);

  // Deduplicate all projects by absolute path, tracking source
  const projectMap = new Map<string, { entry: ProjectEntry; sources: string[] }>();

  for (const entry of entries) {
    if (ignoredProjects.includes(entry.absolutePath)) continue;
    projectMap.set(entry.absolutePath, { entry, sources: ["Open"] });
  }
  for (const entry of recentEntries) {
    if (ignoredProjects.includes(entry.absolutePath)) continue;
    const existing = projectMap.get(entry.absolutePath);
    if (existing) {
      if (!existing.sources.includes("Recent")) existing.sources.push("Recent");
    } else {
      projectMap.set(entry.absolutePath, { entry, sources: ["Recent"] });
    }
  }
  for (const entry of discoveredEntries) {
    if (ignoredProjects.includes(entry.absolutePath)) continue;
    const existing = projectMap.get(entry.absolutePath);
    if (existing) {
      if (!existing.sources.includes("Discovered")) existing.sources.push("Discovered");
    } else {
      projectMap.set(entry.absolutePath, { entry, sources: ["Discovered"] });
    }
  }

  if (projectMap.size === 0) {
    vscode.window.showInformationMessage("Smart Projects: No projects found.");
    return;
  }

  // Build QuickPick items
  const items: vscode.QuickPickItem[] = [];

  for (const [absPath, { entry, sources }] of projectMap) {
    const isCurrent = absPath === currentPath;
    const isPinned = pinned.includes(absPath);
    const tags = getProjectTags(absPath);

    let detail = sources.join(", ");
    if (tags.length > 0) detail += `  ·  ${tags.map(t => `[${t}]`).join(" ")}`;
    if (isCurrent) detail += "  ·  ● current";
    if (isPinned) detail += "  ·  📌";
    if (showGit && entry.gitBranch) {
      detail += `  ·  ${entry.gitBranch}${entry.gitDirty ? "*" : ""}`;
    }

    items.push({
      label: entry.displayName,
      description: absPath,
      detail
    });
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "Search all projects…",
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (!selected || !selected.description) return;

  const targetPath = selected.description;

  if (targetPath === currentPath) {
    vscode.window.showInformationMessage("You are already in this project.");
    return;
  }

  // Ask how to open
  const openChoice = await vscode.window.showQuickPick(
    [
      { label: "$(empty-window) Open in New Window", value: "new" },
      { label: "$(window) Open in Current Window", value: "current" }
    ],
    { placeHolder: `How do you want to open "${selected.label}"?` }
  );

  if (!openChoice) return;

  if (openChoice.value === "current") {
    openProjectInCurrentWindow(targetPath);
  } else {
    openProjectByPath(targetPath);
  }
}

/**
 * Opens a project folder in a new window, or shows a message if it's
 * already the current workspace.
 */
async function openProjectByPath(targetPath: string): Promise<void> {
  const currentPath = getWorkspacePath();

  if (targetPath === currentPath) {
    vscode.window.showInformationMessage("You are already in this project.");
    return;
  }

  await vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.file(targetPath),
    { forceNewWindow: true }
  );
}

/**
 * Opens a project folder in the current window.
 */
async function openProjectInCurrentWindow(targetPath: string): Promise<void> {
  const currentPath = getWorkspacePath();

  if (targetPath === currentPath) {
    vscode.window.showInformationMessage("You are already in this project.");
    return;
  }

  await vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.file(targetPath),
    { forceNewWindow: false }
  );
}

/**
 * Opens a system dialog to select a new folder to open as a project.
 */
async function handleOpenNewProject(): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Open Project"
  });

  if (uris && uris.length > 0) {
    // If a workspace is already open, open the new one in a new window to prevent replacing it.
    // Otherwise, open it in the current blank window.
    const hasWorkspace = getWorkspacePath() !== undefined;
    await vscode.commands.executeCommand("vscode.openFolder", uris[0], { forceNewWindow: hasWorkspace });
  }
}

/**
 * Opens a system dialog to select folders to add to the scanDirectories configuration.
 */
async function handleAddScanDirectory(): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: true,
    openLabel: "Add to Scan Directories",
    title: "Select folders to automatically scan for projects"
  });

  if (!uris || uris.length === 0) return;

  const config = vscode.workspace.getConfiguration("smartProjects");
  const existing = config.get<string[]>("scanDirectories", []);
  
  const newPaths = uris.map(u => u.fsPath);
  const combined = Array.from(new Set([...existing, ...newPaths]));

  await config.update("scanDirectories", combined, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Added ${uris.length} folder(s) to scan directories. Scanning...`);
}

// ─── Status Bar items (one per project) ──────────────────────────────────────

/**
 * Returns a consistent ThemeColor. Checks for a user-defined custom color first;
 * if none, falls back to a string hash of the project name.
 */
function getProjectColor(projectName: string, absolutePath: string): vscode.ThemeColor {
  const config = vscode.workspace.getConfiguration("smartProjects");
  const customColors = config.get<Record<string, string>>("customColors", {});
  if (customColors[absolutePath]) {
    return new vscode.ThemeColor(customColors[absolutePath]);
  }

  const colors = [
    "terminal.ansiBlue",
    "terminal.ansiGreen",
    "terminal.ansiMagenta",
    "terminal.ansiCyan",
    "terminal.ansiYellow",
    "terminal.ansiRed",
    "terminal.ansiBrightBlue",
    "terminal.ansiBrightGreen",
    "terminal.ansiBrightMagenta",
    "terminal.ansiBrightCyan",
    "terminal.ansiBrightYellow",
    "terminal.ansiBrightRed",
    "charts.blue",
    "charts.green",
    "charts.purple",
    "charts.orange",
    "charts.yellow",
    "charts.red"
  ];
  let hash = 0;
  for (let i = 0; i < projectName.length; i++) {
    hash = projectName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % colors.length;
  return new vscode.ThemeColor(colors[index]);
}

/**
 * Disposes all dynamically created per-project status bar items.
 */
function clearDynamicStatusBarItems(): void {
  for (const item of dynamicStatusBarItems) {
    item.dispose();
  }
  dynamicStatusBarItems = [];
}

/**
 * Creates (or recreates) one status bar item per open project.
 * The current project is visually distinguished with a green highlight.
 * Each item is clickable and opens the corresponding project.
 *
 * Items are placed at priority 99 → 0 (left of the main "Projects" button
 * which sits at priority 100) so they appear in a natural reading order.
 */
function syncStatusBarItems(): void {
  clearDynamicStatusBarItems();

  const mode = getDisplayMode();
  if (mode === "statusBarTags") {
    const entries = getFreshEntries();
    const tagsSet = new Set<string>();
    let hasUntagged = false;

    entries.forEach(entry => {
      const tags = getProjectTags(entry.absolutePath);
      if (tags.length === 0) hasUntagged = true;
      else tags.forEach(t => tagsSet.add(t));
    });

    const tags = Array.from(tagsSet).sort();
    if (hasUntagged) tags.push("Untagged");

    tags.forEach((tag, index) => {
      const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        99 - index
      );
      item.text = `$(tag) ${tag}`;
      item.tooltip = `Show projects for tag: ${tag}`;
      item.command = {
        command: "smartProjects.showProjectsByTag",
        title: "Show Projects by Tag",
        arguments: [tag]
      };
      item.show();
      dynamicStatusBarItems.push(item);
    });
    return;
  }

  const entries = getFreshEntries();
  const currentPath = getWorkspacePath();

  entries.forEach((entry, index) => {
    const isCurrent = entry.absolutePath === currentPath;

    // Priority counts down so items stay in alphabetical order (left → right).
    const item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99 - index
    );

    item.text = isCurrent
      ? `$(circle-filled) ${entry.displayName}`
      : `$(window) ${entry.displayName}`;

    item.tooltip = isCurrent
      ? `${entry.absolutePath} (current)`
      : `Open ${entry.displayName} in new window`;

    // Apply a consistent color to the text and icon
    item.color = getProjectColor(entry.displayName, entry.absolutePath);

    if (isCurrent) {
      item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.prominentBackground"
      );
    }

    // Each item triggers opening that specific project.
    item.command = {
      command: "smartProjects.openProject",
      title: "Open Project",
      arguments: [entry.absolutePath],
    };

    item.show();
    dynamicStatusBarItems.push(item);
  });
}

// ─── Main command handler ────────────────────────────────────────────────────

/**
 * Dispatches to QuickPick, sidebar TreeView, bottom Panel, or refreshes the
 * inline status bar items based on the user's `smartProjects.displayMode`
 * setting.
 */
async function handleShowProjects(): Promise<void> {
  const mode = getDisplayMode();

  if (mode === "treeView") {
    // Refresh the tree data, then reveal the sidebar view.
    projectTreeProvider?.refresh();
    await vscode.commands.executeCommand(
      "smartProjects.projectList.focus"
    );
  } else if (mode === "panel") {
    // Refresh the tree data, then reveal the bottom panel view.
    projectTreeProvider?.refresh();
    await vscode.commands.executeCommand(
      "smartProjects.projectListPanel.focus"
    );
  } else if (mode === "statusBar" || mode === "statusBarTags") {
    // In statusBar modes, items are always visible; clicking the main button
    // just forces a refresh.
    syncStatusBarItems();
  } else {
    await showProjectPicker();
  }
}

// ─── Settings commands ───────────────────────────────────────────────────────

/**
 * Updates the displayMode setting to the specified value.
 */
async function setDisplayMode(mode: DisplayMode): Promise<void> {
  await vscode.workspace
    .getConfiguration("smartProjects")
    .update("displayMode", mode, vscode.ConfigurationTarget.Global);
}

/** Updates the custom context key used by package.json for menu checkmarks. */
function updateDisplayModeContext(): void {
  vscode.commands.executeCommand(
    "setContext",
    "smartProjects:displayMode",
    getDisplayMode()
  );
}

// ─── Extension lifecycle ─────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // ── Resolve the shared state file path ──────────────────────────────────
  // By using `os.homedir()`, the state is globally shared across ALL VS Code
  // instances, even if they use different profiles or `--userDataDir`.
  stateFilePath = path.join(os.homedir(), STATE_FILE);
  recentFilePath = path.join(os.homedir(), RECENT_FILE);
  ensureStorageDir();

  // ── Tag Migration (String to Array) ──────────────────────────────────────
  const config = vscode.workspace.getConfiguration("smartProjects");
  const rawTags = config.get<Record<string, any>>("projectTags", {});
  let needsMigration = false;
  const migratedTags = { ...rawTags };

  for (const [key, value] of Object.entries(migratedTags)) {
    if (typeof value === "string") {
      migratedTags[key] = value.trim() ? [value.trim()] : [];
      needsMigration = true;
    }
  }

  if (needsMigration) {
    config.update("projectTags", migratedTags, vscode.ConfigurationTarget.Global);
  }

  // ── Create the Status Bar item ──────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = "$(layout-sidebar-right) Projects";
  statusBarItem.tooltip = "Show open projects";
  statusBarItem.command = "smartProjects.showProjects";
  
  if (getDisplayMode() !== "statusBar" && getDisplayMode() !== "statusBarTags") {
    statusBarItem.show();
  }
  context.subscriptions.push(statusBarItem);

  // ── Register Tree Views ─────────────────────────────────────────────────
  // Both the sidebar and panel views share the same data provider so they
  // always display identical, up-to-date content.
  projectTreeProvider = new ProjectTreeDataProvider();

  // Sidebar tree view (Activity Bar).
  sidebarTreeView = vscode.window.createTreeView(
    "smartProjects.projectList",
    {
      treeDataProvider: projectTreeProvider,
      showCollapseAll: false,
    }
  );
  context.subscriptions.push(sidebarTreeView);

  // Bottom panel tree view (next to Terminal, Output, etc.).
  panelTreeView = vscode.window.createTreeView(
    "smartProjects.projectListPanel",
    {
      treeDataProvider: projectTreeProvider,
      showCollapseAll: false,
    }
  );
  context.subscriptions.push(panelTreeView);

  // ── Register Recent Tree Views ──────────────────────────────────────────
  recentProjectTreeProvider = new RecentProjectTreeDataProvider();

  recentSidebarTreeView = vscode.window.createTreeView(
    "smartProjects.recentProjects",
    {
      treeDataProvider: recentProjectTreeProvider,
      showCollapseAll: false,
    }
  );
  context.subscriptions.push(recentSidebarTreeView);

  recentPanelTreeView = vscode.window.createTreeView(
    "smartProjects.recentProjectsPanel",
    {
      treeDataProvider: recentProjectTreeProvider,
      showCollapseAll: false,
    }
  );
  context.subscriptions.push(recentPanelTreeView);

  // ── Register Discovered Tree Views ────────────────────────────────────────
  discoveredProjectTreeProvider = new DiscoveredProjectTreeDataProvider();

  const discoveredSidebarTreeView = vscode.window.createTreeView(
    "smartProjects.discoveredProjects",
    {
      treeDataProvider: discoveredProjectTreeProvider,
      showCollapseAll: false,
    }
  );
  context.subscriptions.push(discoveredSidebarTreeView);

  const discoveredPanelTreeView = vscode.window.createTreeView(
    "smartProjects.discoveredProjectsPanel",
    {
      treeDataProvider: discoveredProjectTreeProvider,
      showCollapseAll: false,
    }
  );
  context.subscriptions.push(discoveredPanelTreeView);

  // ── Register Ignored Tree Views ──────────────────────────────────────────
  ignoredProjectTreeProvider = new IgnoredProjectTreeDataProvider();

  const ignoredSidebarTreeView = vscode.window.createTreeView(
    "smartProjects.ignoredProjects",
    {
      treeDataProvider: ignoredProjectTreeProvider,
      showCollapseAll: false,
    }
  );
  context.subscriptions.push(ignoredSidebarTreeView);

  const ignoredPanelTreeView = vscode.window.createTreeView(
    "smartProjects.ignoredProjectsPanel",
    {
      treeDataProvider: ignoredProjectTreeProvider,
      showCollapseAll: false,
    }
  );
  context.subscriptions.push(ignoredPanelTreeView);

  // Set initial context
  const initialIgnored = vscode.workspace.getConfiguration("smartProjects").get<string[]>("ignoredProjects", []);
  vscode.commands.executeCommand("setContext", "smartProjects:hasIgnoredProjects", initialIgnored.length > 0);

  // Initial background scan
  updateDiscoveredProjectsCache();

  // ── Register commands ───────────────────────────────────────────────────

  // Main command: dispatches based on the displayMode setting.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "smartProjects.showProjects",
      handleShowProjects
    ),
    vscode.commands.registerCommand(
      "smartProjects.openNewProject",
      handleOpenNewProject
    ),
    vscode.commands.registerCommand(
      "smartProjects.addScanDirectory",
      handleAddScanDirectory
    ),
    vscode.commands.registerCommand(
      "smartProjects.showProjectsByTag",
      (tag?: string) => {
        if (tag) showProjectPicker(tag);
      }
    ),
    vscode.commands.registerCommand(
      "smartProjects.searchAllProjects",
      searchAllProjects
    )
  );

  // Open a specific project — used by tree view items and inline buttons.
  // Can receive the path as an argument (from tree item command) or as a
  // ProjectTreeItem (from the inline context menu button).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "smartProjects.openProject",
      (arg?: string | ProjectTreeItem) => {
        let targetPath: string | undefined;
        if (typeof arg === "string") {
          targetPath = arg;
        } else if (arg instanceof ProjectTreeItem) {
          targetPath = arg.entry.absolutePath;
        }
        if (targetPath) {
          openProjectByPath(targetPath);
        }
      }
    )
  );

  // Open Recent commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "smartProjects.openRecentCurrentWindow",
      (arg?: RecentProjectTreeItem | DiscoveredProjectTreeItem) => {
        if (arg && arg.entry) {
          openProjectInCurrentWindow(arg.entry.absolutePath);
        }
      }
    ),
    vscode.commands.registerCommand(
      "smartProjects.openRecentNewWindow",
      (arg?: RecentProjectTreeItem | DiscoveredProjectTreeItem) => {
        if (arg && arg.entry) {
          openProjectByPath(arg.entry.absolutePath);
        }
      }
    )
  );

  // Command to let the user set a custom color for a project.
  async function handleSetProjectColor(arg?: ProjectTreeItem | RecentProjectTreeItem | DiscoveredProjectTreeItem) {
    let targetEntry: ProjectEntry | undefined;

    if (arg && 'entry' in arg) {
      targetEntry = arg.entry;
    } else {
      // Called from Command Palette — prompt the user to pick a project first.
      const entries = getFreshEntries();
      if (entries.length === 0) {
        vscode.window.showInformationMessage("No open projects found.");
        return;
      }
      const items: vscode.QuickPickItem[] = entries.map((entry) => ({
        label: entry.displayName,
        description: entry.absolutePath,
      }));
      const selectedProject = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a project to change its color...",
      });
      if (!selectedProject) return;
      targetEntry = entries.find((e) => e.absolutePath === selectedProject.description);
    }

    if (!targetEntry) return;

    const colors = [
      "terminal.ansiBlue", "terminal.ansiGreen", "terminal.ansiMagenta",
      "terminal.ansiCyan", "terminal.ansiYellow", "terminal.ansiRed",
      "terminal.ansiBrightBlue", "terminal.ansiBrightGreen", "terminal.ansiBrightMagenta",
      "terminal.ansiBrightCyan", "terminal.ansiBrightYellow", "terminal.ansiBrightRed",
      "charts.blue", "charts.green", "charts.purple",
      "charts.orange", "charts.yellow", "charts.red"
    ];

    const emojiMap: Record<string, string> = {
      "terminal.ansiBlue": "🔵", "terminal.ansiGreen": "🟢", "terminal.ansiMagenta": "🟣",
      "terminal.ansiCyan": "💠", "terminal.ansiYellow": "🟡", "terminal.ansiRed": "🔴",
      "terminal.ansiBrightBlue": "🟦", "terminal.ansiBrightGreen": "🟩", "terminal.ansiBrightMagenta": "🟪",
      "terminal.ansiBrightCyan": "🩵", "terminal.ansiBrightYellow": "🟨", "terminal.ansiBrightRed": "🟥",
      "charts.blue": "🔷", "charts.green": "🍀", "charts.purple": "🍇",
      "charts.orange": "🟠", "charts.yellow": "🔸", "charts.red": "🔺"
    };

    interface ColorQuickPickItem extends vscode.QuickPickItem {
      colorId: string;
    }

    const colorItems: ColorQuickPickItem[] = [
      { 
        label: "$(color-mode) Default", 
        description: "Reset to automatically generated color", 
        picked: true,
        colorId: "Default"
      },
      ...colors.map(c => ({ 
        label: `${emojiMap[c] || '🎨'} ${c}`,
        colorId: c
      }))
    ];

    const selectedColor = await vscode.window.showQuickPick(colorItems, {
      placeHolder: `Choose a color for ${targetEntry.displayName}`,
    });

    if (!selectedColor) return;

    const config = vscode.workspace.getConfiguration("smartProjects");
    const customColors = { ...config.get<Record<string, string>>("customColors", {}) };
    
    if (selectedColor.colorId === "Default") {
      delete customColors[targetEntry.absolutePath];
    } else {
      customColors[targetEntry.absolutePath] = selectedColor.colorId;
    }

    await config.update("customColors", customColors, vscode.ConfigurationTarget.Global);
    
    // Force an immediate UI refresh
    projectTreeProvider?.refresh();
    recentProjectTreeProvider?.refresh();
    if (getDisplayMode() === "statusBar") {
      syncStatusBarItems();
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "smartProjects.setProjectColor",
      handleSetProjectColor
    ),
    vscode.commands.registerCommand(
      "smartProjects.forgetProject",
      handleForgetProject
    ),
    vscode.commands.registerCommand(
      "smartProjects.unforgetProject",
      handleUnforgetProject
    ),
    vscode.commands.registerCommand(
      "smartProjects.closeProject",
      async (arg?: ProjectTreeItem) => {
        if (!arg) return;
        const targetPath = arg.entry.absolutePath;
        if (targetPath === getWorkspacePath()) {
          vscode.commands.executeCommand("workbench.action.closeWindow");
        } else {
          let state = readState();
          const index = state.findIndex(p => p.absolutePath === targetPath);
          if (index !== -1) {
            state[index].closeRequested = true;
            writeState(state);
            vscode.window.showInformationMessage(`Sent close request to ${arg.entry.displayName}...`);
          }
        }
      }
    )
  );

  // Command to let the user set or remove a custom tag for a project.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "smartProjects.setProjectTag",
      handleSetProjectTag
    ),
    vscode.commands.registerCommand(
      "smartProjects.removeProjectTag",
      handleRemoveProjectTag
    ),
    vscode.commands.registerCommand(
      "smartProjects.filterByTag",
      handleFilterByTag
    )
  );

  // Pin/Unpin commands
  context.subscriptions.push(
    vscode.commands.registerCommand("smartProjects.pinProject", (arg?: ProjectTreeItem) => {
      if (arg instanceof ProjectTreeItem) togglePin(arg.entry.absolutePath, true);
    }),
    vscode.commands.registerCommand("smartProjects.unpinProject", (arg?: ProjectTreeItem) => {
      if (arg instanceof ProjectTreeItem) togglePin(arg.entry.absolutePath, false);
    })
  );

  // Refresh command for the tree view title bar buttons (works for both views).
  context.subscriptions.push(
    vscode.commands.registerCommand("smartProjects.refreshProjects", () => {
      projectTreeProvider?.refresh();
      recentProjectTreeProvider?.refresh();
      // Only do a full background scan on manual refresh
      updateDiscoveredProjectsCache();
    })
  );

  // Settings commands for changing the display mode from the native submenu.
  // We register both .active and .inactive variants of each command to handle the manual checkmarks.
  context.subscriptions.push(
    vscode.commands.registerCommand("smartProjects.setDisplayMode.quickPick.active", () => setDisplayMode("quickPick")),
    vscode.commands.registerCommand("smartProjects.setDisplayMode.quickPick.inactive", () => setDisplayMode("quickPick")),
    vscode.commands.registerCommand("smartProjects.setDisplayMode.statusBar.active", () => setDisplayMode("statusBar")),
    vscode.commands.registerCommand("smartProjects.setDisplayMode.statusBar.inactive", () => setDisplayMode("statusBar")),
    vscode.commands.registerCommand("smartProjects.setDisplayMode.statusBarTags.active", () => setDisplayMode("statusBarTags")),
    vscode.commands.registerCommand("smartProjects.setDisplayMode.statusBarTags.inactive", () => setDisplayMode("statusBarTags"))
  );

  // ── Initial registration & heartbeat ────────────────────────────────────
  registerCurrentWorkspace();

  heartbeatTimer = setInterval(() => {
    registerCurrentWorkspace();
  }, HEARTBEAT_INTERVAL_MS);

  // Polling for remote close requests
  closeCheckTimer = setInterval(() => {
    const wsPath = getWorkspacePath();
    if (!wsPath) return;
    const entries = readState();
    const entry = entries.find(e => e.absolutePath === wsPath);
    if (entry && entry.closeRequested) {
      vscode.commands.executeCommand("workbench.action.closeWindow");
    }
  }, 2000);

  // Ensure the interval is cleared when the extension host shuts down.
  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (closeCheckTimer) {
        clearInterval(closeCheckTimer);
        closeCheckTimer = undefined;
      }
    })
  );

  // ── React to workspace folder changes (e.g. user adds/removes roots) ───
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      registerCurrentWorkspace();
    })
  );

  // ── React to setting changes ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("smartProjects.customColors") ||
        e.affectsConfiguration("smartProjects.pinnedProjects") ||
        e.affectsConfiguration("smartProjects.projectTags") ||
        e.affectsConfiguration("smartProjects.showGitStatus") ||
        e.affectsConfiguration("smartProjects.useLanguageIcons")
      ) {
        projectTreeProvider?.refresh();
        recentProjectTreeProvider?.refresh();
        discoveredProjectTreeProvider?.refresh();
        if (getDisplayMode() === "statusBar") {
          syncStatusBarItems();
        }
      }

      if (e.affectsConfiguration("smartProjects.scanDirectories")) {
        updateDiscoveredProjectsCache();
      }

      if (e.affectsConfiguration("smartProjects.displayMode")) {
        const mode = getDisplayMode();
        updateDisplayModeContext();

        // Update tooltip to hint which mode is active.
        const modeLabels: Record<string, string> = {
          quickPick: "quick pick",
          treeView: "sidebar",
          panel: "panel",
          statusBar: "status bar",
          statusBarTags: "status bar tags"
        };
        statusBarItem.tooltip = `Show open projects (${modeLabels[mode] ?? mode})`;

        // Show or hide dynamic status bar items depending on the mode.
        if (mode === "statusBar" || mode === "statusBarTags") {
          statusBarItem.hide();
          syncStatusBarItems();
        } else {
          statusBarItem.show();
          clearDynamicStatusBarItems();
        }
      }
    })
  );

  // ── Bootstrap statusBar mode if it's already the active setting ─────────
  if (getDisplayMode() === "statusBar" || getDisplayMode() === "statusBarTags") {
    syncStatusBarItems();
  }

  // Ensure the native menu checkmarks reflect the current state on startup.
  updateDisplayModeContext();
}

export function deactivate(): void {
  // Stop heartbeating.
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  if (closeCheckTimer) {
    clearInterval(closeCheckTimer);
    closeCheckTimer = undefined;
  }

  // Clean up dynamic status bar items.
  clearDynamicStatusBarItems();

  // Remove ourselves from the shared state so other windows see an
  // up-to-date list immediately.
  unregisterCurrentWorkspace();
}
