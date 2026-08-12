# Smart Projects for VS Code

**Smart Projects** is a powerful, globally synchronized workspace manager and quick launcher for Visual Studio Code. 

Unlike built-in features that only remember recent folders, Smart Projects acts as a persistent global dashboard. It tracks your actively open windows, auto-discovers your un-opened repositories, manages your recent history, and lets you organize everything perfectly with tags, colors, and pins across *all* your VS Code instances.

## ✨ Features

### 🔭 Auto-Discovery
Point the extension to your code folders, and it will instantly discover all your repositories in the background.
* Add absolute paths (like `~/programming`) to your `smartProjects.scanDirectories` setting.
* A brand new **"Discovered Projects"** pane cleanly lists all un-opened repositories it finds.
* Automatically detects `.git`, `package.json`, `pom.xml`, and `.vscode` folders up to 3 levels deep.
* **Smart Filtering**: Once you open a discovered project, it moves to your "Open Projects" list to prevent UI clutter.

### 🐙 Live Git Status Integration
Instantly see the Git state of your active projects from anywhere.
* Projects automatically display their current checked-out branch (e.g. `[main]`).
* Uncommitted changes are indicated with an asterisk `*`.
* **Live Syncing**: Because the extension heartbeats across all windows, changing branches in one window instantly updates the status in all other windows!

### 📌 Pinning & 🏷️ Tag Groups
Organize your chaotic list of projects exactly how you want them.
* **Pinning**: Hover over any project and click the pushpin `$(pin)` icon to permanently anchor it to the top of your lists.
* **Tagging**: Group related projects into collapsible folders. Click the tag `$(tag)` icon to open the Tag Manager. 
  * A single project can have **multiple tags** simultaneously!
  * Select from existing tags or create brand new ones on the fly.
  * Projects with the same tags are beautifully grouped together in the Sidebar, Bottom Panel, and Quick Pick!
* **Tag Filtering**: A new filter `$(filter)` button at the top of the Sidebar views allows you to selectively show or hide specific tag groups to keep your view perfectly clean.

### 🕒 Recent Projects
A dedicated history pane automatically tracks the last 20 projects you've opened.
* Shows exact timestamps (e.g. "just now", "2 hours ago").
* Intelligently hides projects that are already open to save space.

### 🎨 Colorful & Language-Specific Indicators
Visually identify your projects at a glance.
* **Language Icons**: The extension automatically detects the primary programming language of your project (e.g., Python, Go, TypeScript) and uses your active VS Code File Icon Theme to display the corresponding logo!
* **Custom Colors**: If language icons are disabled, you can assign custom colors to individual projects `$(symbol-color)`.
* **Git Repo Icons**: If a project is untagged and doesn't have a specific language, but tracks a Git repository, it displays a neat `$(repo)` icon!

### 🙈 Forget Projects (Ignore List)
Got a stubborn folder you never want to see again?
* Click the **Forget Project** `$(close)` icon on any item.
* The project instantly vanishes and will *never* appear in your Open, Recent, or Discovered lists again.
* If you make a mistake, restore it from the **"Ignored Projects"** panel using the Unforget `$(reply)` button!

### 🔍 Search All Projects
Instantly find any project across all sources with a single keystroke.
* Press `Cmd+Shift+O` (Mac) / `Ctrl+Shift+O` (Windows/Linux) to open the unified search.
* Searches across **Open**, **Recent**, and **Discovered** projects simultaneously.
* Results are deduplicated and show source, tags, git branch, and pin status.
* After selecting a project, choose to open it in the **current window** or a **new window**.
* Also available via the `$(search)` icon in the sidebar and from the Command Palette.

### 🌍 Global Synchronization
Smart Projects is designed for multi-window power users.
* Powered by a hidden, globally shared `state.json` file.
* Pins, Tags, Colors, and Git Status are synchronized seamlessly across every single active VS Code window in real-time.

---

## 🛠️ Configuration Settings

Customize the extension's behavior via your VS Code `settings.json`:

* `smartProjects.displayMode`: Choose where the main Project List should appear (`sidebar`, `panel`, `statusBar`, or the new `statusBarTags` which creates clickable buttons for each tag).
* `smartProjects.useLanguageIcons`: Automatically detect and display language-specific file icons for projects (default: `true`).
* `smartProjects.scanDirectories`: An array of folder paths to automatically scan for projects.
* `smartProjects.showGitStatus`: Toggle the display of git branches and dirty status (default: `true`).
* `smartProjects.ignoredProjects`: An array of absolute paths that the extension should completely ignore.
* `smartProjects.pinnedProjects`: Internal array tracking your pinned projects.
* `smartProjects.projectColors`: Internal mapping of your custom project colors.
* `smartProjects.projectTags`: Internal mapping of your custom tag groupings.

---

## 🚀 Commands

Access these from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):
* `Smart Projects: Search All Projects` - Unified search across all project sources. (`Cmd+Shift+O` / `Ctrl+Shift+O`)
* `Smart Projects: Show Open Projects` - Opens the ultimate global Quick Pick launcher.
* `Smart Projects: Open New Project...` - Opens your OS file browser to load a new folder.
* `Smart Projects: Set Project Color` - Apply a custom color to a project.
* `Smart Projects: Set Project Tag` - Group a project into a custom tag folder.
* `Smart Projects: Forget Project` - Add a project to your ignore list.

Enjoy a cleaner, faster, and more organized VS Code experience!
