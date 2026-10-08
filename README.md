# DSH File And Terminal

Adds always-visible **终端** and **文件管理** main panels to the Web profile, and also registers them with `dsh-better-sidebar` when that service is available.

When `dsh-better-sidebar` is available, both modules register as its tabs in one shared, disposable client effect. Sidebar tabs and main panels share one Explorer cache/download state and one host Bash PTY/xterm instance; the terminal's DOM is handed to the active view rather than creating another process. The DSH main panels remain registered independently; Better Sidebar or slot registration errors are isolated and logged instead of failing plugin activation.

Install from this directory with:

```sh
dsh plugin --profile web add .
```

Restart the Web profile after adding the bundle:

```sh
dsh web
```

The Explorer starts at the configured `root` (default `~`). Dotfiles and dot-directories are dimmed and sorted after visible entries. It follows only symlinks whose targets stay inside that root, supports uploading files and directories, downloads regular files, and packages directories as ZIP archives. Uploads and downloads are separately limited by `maxUploadBytes` and `maxDownloadBytes` (64 MiB by default); directory archives are limited by total uncompressed size. Uploads preserve directory structure and do not overwrite existing entries. Configure values in `cordis.patch.yml`; `maxEntries` bounds each listing. This is host filesystem access and should only be enabled for a trusted Web deployment.

The Terminal panel is a standalone full-page Bash PTY, independent of conversations and Sessions. Switching to another panel keeps the PTY, xterm screen, and file-browser location/list alive; the terminal is terminated when the Web page closes or the host plugin unloads. It starts in the configured `root` and uses the host's managed PTY subprocess service with xterm.js rendering.
