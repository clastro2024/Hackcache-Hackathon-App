# Operational and collaboration guide

## 1. Which repository owns what

This repository owns the app: backend, future frontend/runtime assets, tests, dependency files and app-facing documentation. Use its GitHub issues and pull requests for app changes.

The larger planning workspace is separate. When this clone lives inside its `App` folder, the parent ignores that entire folder; app changes must be committed and pushed from this repository. A parent-repository commit or push does not back up app work. A fresh parent clone does not contain the app until it is cloned separately.

You can also clone this app anywhere and work without the planning workspace. There is no subtree/submodule workflow and no shared commit history to synchronize.

## 2. First setup

Install Git and Python 3.12, then use the README clone/environment/install commands. Use a virtual environment per clone; do not commit or copy `.venv` between machines. No environment file or external API key is currently required. Real-provider credentials must never be added to fixtures or committed later.

Set your own Git author identity if needed:

```powershell
git config user.name "Your Name"
git config user.email "YOUR_GITHUB_NOREPLY_EMAIL"
git remote -v
git status --short --branch
```

Use your own GitHub account and credential manager/SSH credentials. The repository owner grants write access through GitHub Settings → Collaborators or the organization/team equivalent. Public read access does not itself grant push access. Do not share passwords or tokens.

## 3. Everyday app work

Run these inside the app repository. Keep your working tree clean or deliberately commit/stash your work before switching branches.

```powershell
git switch main
git pull --ff-only origin main
git switch -c codex/describe-the-change
```

Implement one focused change and run the affected checks:

```powershell
.\.venv\Scripts\python.exe -m pytest tests/ -q
.\.venv\Scripts\python.exe -m pip check
git diff
git status --short
git add -- backend tests
git diff --cached
git commit -m "Describe the resulting behavior"
git push -u origin codex/describe-the-change
```

Replace the staged paths with the exact files you changed, including documentation/dependencies where relevant. Stage deliberately and inspect the cached diff; do not add local data, keys, logs or environments. Use a unique branch per task/person.

Open a pull request into `main`, describe behavior and real validation, wait for checks and ask a teammate to review. After merge:

```powershell
git switch main
git pull --ff-only origin main
git branch -d codex/describe-the-change
```

GitHub Settings → Rules/Branches can protect `main` and require reviews/CI if the repository's permissions and plan allow it. No server-side protection rule is established merely by this guide.

## 4. Bring main into an active branch

First commit or deliberately stash your current work, then:

```powershell
git fetch origin
git merge origin/main
```

Resolve each conflict in its actual context. Remove conflict markers, stage only resolved files, rerun checks and commit the merge when needed. `git merge --abort` abandons the merge while it is in progress. Avoid force-pushing shared branches. A `--ff-only` pull stopping is useful evidence of divergence; inspect the graph and merge instead of discarding either person's work.

Two people should coordinate ownership of the same service/schema to limit conflicts. App changes have one authoritative remote: this repository.

## 5. Run, stop and reset the current prototype

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000/docs`. Stop with Ctrl+C. The current services seed fictional state in memory; restarting the process recreates that baseline and loses runtime changes. This is not durable database recovery. Use one process/worker for this snapshot.

For development, `--reload` restarts the process on changes and therefore resets this in-memory state. If port 8000 is occupied, choose `--port 8001` and use that address; do not terminate unrelated processes.

The project does not yet contain the planned frontend, database maintenance CLI or real ASR adapter. Do not invent seed/reset/deploy commands for those targets. Bind locally; current authentication/disclosure gaps are described in SECURITY.md and docs/STATUS.md.

On macOS/Linux use `.venv/bin/python` in place of the Windows interpreter path.

## 6. Dependency maintenance

`requirements.txt` declares runtime packages; `requirements-dev.txt` adds test tools. Both resolve against `constraints.txt`, which records the versions used during setup. Update a dependency intentionally, refresh compatible pins in an isolated environment, run `pip check` and the tests, and review the dependency diff together.

Install with:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
```

CI uses pinned GitHub Action revisions and Python 3.12 on Windows/Linux. Review action/dependency upgrades as code changes. A missing or queued check is not a passing check. The current small suite is service-level coverage, not the revised architecture's security/clinical acceptance suite.

## 7. Push and access troubleshooting

- **LF/CRLF warning:** text line endings are governed by `.gitattributes`; this warning is distinct from a failed upload. Avoid mass renormalization during unrelated work.
- **Non-fast-forward:** fetch and merge remote changes, then push. Preserve both contributors' work.
- **HTTP 408/disconnect:** do not infer success from “Everything up-to-date” after fatal errors. Compare the remote branch with the local commit:
  ```powershell
  git rev-parse main
  git ls-remote origin refs/heads/main
  ```
  If repeated, try a different network or properly configured SSH. Do not rewrite history to fix a transport failure.
- **Authentication/403:** check `git remote -v`, the signed-in GitHub account and repository write access. Authenticate through your credential manager or SSH; never paste a token into a remote URL, issue, log or chat.
- **Ignored source file:** inspect `git check-ignore -v -- path/to/file` before changing ignore rules. The parent intentionally ignores this entire app clone.

## 8. Recovery and handoff

A local commit is not a remote backup until its push is confirmed. Before handing off, push the branch, share the pull request and state tests, remaining gaps and any required migration. A teammate should be able to clone/install/test using this repository alone.

Use new commits to reverse published changes (`git revert`), rather than erasing shared history. Review any local discard carefully: it can remove uncommitted work. No force-push, reset or recursive deletion is part of the ordinary workflow.

The owner should choose a project license and confirm collaborator access before broader reuse. Neither license selection nor collaborator permissions are implied by the presence of this document.
