"""Git operations for the Jumper KiCad plugin.

Kept free of KiCad and wx imports so it can be tested with plain Python. Everything shells out to the `git` command
line: no extra Python packages are needed inside KiCad's bundled interpreter.
"""

import json
import os
import re
import stat
import subprocess
import urllib.error
import urllib.request
from urllib.parse import quote, urlparse

# Files KiCad writes that should never be committed.
KICAD_IGNORES = [
    "# KiCad temporary files",
    "*-backups/",
    "_autosave-*",
    "*.lck",
    "~*.lck",
    "fp-info-cache",
    "*.kicad_prl",
    "*-bak",
    "*.bak",
    "#auto_saved_files#",
    "# Generated outputs (Jumper builds these from each push)",
    "/gerbers/",
    "/fab/",
]

# Pass a fixed environment so a user's global git config (pagers, editors, prompts) cannot hang KiCad.
_BASE_ENV = {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_EDITOR": "true",
    "GIT_PAGER": "cat",
    "LC_ALL": "C",
}


class GitError(Exception):
    """A git command failed; `str(e)` is a message fit to show the user."""


def _friendly(stderr):
    s = stderr.lower()
    if "not a git repository" in s:
        return "This project is not connected to Jumper yet."
    if re.search(r"authentication failed|could not read username|invalid username or password|http 401|403", s):
        return "Jumper refused the credentials. Check the access token in Jumper settings (it needs repo:write to push)."
    if "permission denied (publickey)" in s:
        return "Your SSH key was refused. Add it under Settings > SSH keys on Jumper, or use an HTTPS URL with a token."
    if "could not resolve host" in s or "failed to connect" in s or "connection refused" in s:
        return "Could not reach the server. Check your internet connection and the repository URL."
    if "non-fast-forward" in s or "fetch first" in s or "rejected" in s:
        return "Someone else pushed changes first. Pull, check the result in KiCad, then push again."
    if "not possible to fast-forward" in s or "diverging branches" in s or "have diverged" in s:
        return ("Your copy and Jumper both have new commits. Open a terminal in the project folder and run "
                "'git pull --rebase', or push your work to a new branch and open a pull request.")
    if "would be overwritten" in s or "local changes" in s:
        return "You have unsaved or uncommitted changes that the pull would overwrite. Commit them first."
    if "protected branch" in s or "requires a pull request" in s:
        return "This branch is protected. Push to a new branch and open a pull request on Jumper."
    if "nothing to commit" in s:
        return "Nothing to commit: all changes are already saved in git."
    lines = [l for l in stderr.strip().splitlines() if l.strip()]
    return lines[-1] if lines else "git failed"


def git_available():
    try:
        subprocess.run(["git", "--version"], capture_output=True, check=True, timeout=10, **_no_window())
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def _no_window():
    # On Windows, do not flash a console window for each git call.
    if os.name == "nt":
        return {"creationflags": 0x08000000}
    return {}


def run(args, cwd, token=None, timeout=300, check=True):
    """Run git and return stdout. `token`, when given, is sent as a bearer header for HTTPS remotes only."""
    cmd = ["git"]
    if token:
        cmd += ["-c", "http.extraHeader=Authorization: Bearer " + token]
    cmd += list(args)
    env = dict(os.environ)
    env.update(_BASE_ENV)
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env, **_no_window())
    except FileNotFoundError:
        raise GitError("git is not installed. Install it from https://git-scm.com and restart KiCad.")
    except subprocess.TimeoutExpired:
        raise GitError("git took too long and was stopped.")
    if check and p.returncode != 0:
        raise GitError(_friendly(p.stderr or p.stdout))
    return p.stdout


def find_repo_root(path):
    """Top of the git repository containing `path` (a file or folder), or None."""
    folder = path if os.path.isdir(path) else os.path.dirname(os.path.abspath(path))
    try:
        out = run(["rev-parse", "--show-toplevel"], cwd=folder, timeout=20)
    except GitError:
        return None
    return os.path.normpath(out.strip()) if out.strip() else None


def remote_url(root, name="origin"):
    try:
        return run(["remote", "get-url", name], cwd=root, timeout=20).strip() or None
    except GitError:
        return None


def web_url(clone_url):
    """The Jumper page for a clone URL: https://host/owner/repo.git or ssh://git@host:2222/owner/repo.git or git@host:owner/repo.git."""
    if not clone_url:
        return None
    u = clone_url.strip()
    m = re.match(r"^[\w.-]+@([^:/]+):(.+)$", u)
    if m:
        return "https://%s/%s" % (m.group(1), re.sub(r"\.git/?$", "", m.group(2)))
    p = urlparse(u)
    if p.scheme in ("http", "https"):
        host = p.hostname + (":%d" % p.port if p.port else "")
        return "%s://%s%s" % (p.scheme, host, re.sub(r"\.git/?$", "", p.path))
    if p.scheme == "ssh":
        return "https://%s%s" % (p.hostname, re.sub(r"\.git/?$", "", p.path))
    return None


def host_of(clone_url):
    if not clone_url:
        return None
    m = re.match(r"^[\w.-]+@([^:/]+):", clone_url)
    if m:
        return m.group(1).lower()
    p = urlparse(clone_url)
    return (p.hostname or "").lower() or None


def is_https(clone_url):
    return bool(clone_url) and clone_url.lower().startswith(("https://", "http://"))


def parse_status(porcelain):
    """Parse `git status --porcelain=v2 --branch` output."""
    info = {"branch": None, "upstream": None, "ahead": 0, "behind": 0, "changes": []}
    for line in porcelain.splitlines():
        if line.startswith("# branch.head "):
            head = line[len("# branch.head "):]
            info["branch"] = None if head == "(detached)" else head
        elif line.startswith("# branch.upstream "):
            info["upstream"] = line[len("# branch.upstream "):]
        elif line.startswith("# branch.ab "):
            m = re.match(r"# branch\.ab \+(\d+) -(\d+)", line)
            if m:
                info["ahead"], info["behind"] = int(m.group(1)), int(m.group(2))
        elif line.startswith("1 ") or line.startswith("2 "):
            # "1 XY sub mH mI mW hH hI path" / "2 XY sub mH mI mW hH hI Xscore path<TAB>orig"
            renamed = line.startswith("2 ")
            parts = line.split(" ", 9 if renamed else 8)
            xy = parts[1]
            path = parts[-1].split("\t")[0] if renamed else parts[-1]
            info["changes"].append((_describe(xy), path))
        elif line.startswith("? "):
            info["changes"].append(("new", line[2:]))
        elif line.startswith("u "):
            info["changes"].append(("conflict", line.split(" ", 10)[-1]))
    return info


def _describe(xy):
    x, y = xy[0], xy[1]
    code = y if y != "." else x
    return {"M": "modified", "A": "new", "D": "deleted", "R": "renamed", "C": "copied", "T": "modified"}.get(code, "modified")


def status(root, fetch_first=False, token=None):
    if fetch_first and remote_url(root):
        try:
            run(["fetch", "--quiet", "origin"], cwd=root, token=token, timeout=120)
        except GitError:
            pass  # offline: show local status
    return parse_status(run(["status", "--porcelain=v2", "--branch", "--untracked-files=all"], cwd=root, timeout=60))


def ensure_gitignore(root):
    """Add KiCad's temporary files to .gitignore without touching lines the user wrote."""
    path = os.path.join(root, ".gitignore")
    existing = []
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            existing = f.read().splitlines()
    missing = [l for l in KICAD_IGNORES if l not in existing]
    if not [l for l in missing if not l.startswith("#")]:
        return False
    with open(path, "a", encoding="utf-8") as f:
        if existing and existing[-1].strip():
            f.write("\n")
        f.write("\n".join(missing) + "\n")
    return True


def commit_all(root, message, author_name=None, author_email=None):
    """Stage every change (respecting .gitignore) and commit. Returns the new commit sha."""
    if not message.strip():
        raise GitError("Write a short message describing what you changed.")
    run(["add", "--all"], cwd=root)
    args = []
    if author_name and author_email:
        args += ["-c", "user.name=" + author_name, "-c", "user.email=" + author_email]
    run(args + ["commit", "--quiet", "-m", message], cwd=root)
    return run(["rev-parse", "HEAD"], cwd=root, timeout=20).strip()


def has_identity(root):
    name = run(["config", "user.name"], cwd=root, check=False, timeout=20).strip()
    email = run(["config", "user.email"], cwd=root, check=False, timeout=20).strip()
    return bool(name and email)


def set_identity(root, name, email):
    run(["config", "user.name", name], cwd=root)
    run(["config", "user.email", email], cwd=root)


def pull(root, token=None):
    """Fast-forward to the remote. Never merges or rewrites: divergence is reported, not resolved behind the user's back."""
    info = status(root)
    if any(kind == "conflict" for kind, _ in info["changes"]):
        raise GitError("There are unresolved conflicts in this project. Resolve them in a terminal first.")
    branch = info["branch"]
    if not branch:
        raise GitError("You are not on a branch. Check out a branch first.")
    run(["fetch", "--quiet", "origin"], cwd=root, token=token)
    upstream = info["upstream"] or "origin/" + branch
    remote_has = run(["rev-parse", "--verify", "--quiet", upstream], cwd=root, check=False, timeout=20).strip()
    if not remote_has:
        return 0
    before = run(["rev-parse", "HEAD"], cwd=root, timeout=20).strip()
    run(["merge", "--ff-only", "--quiet", upstream], cwd=root)
    after = run(["rev-parse", "HEAD"], cwd=root, timeout=20).strip()
    if before == after:
        return 0
    return int(run(["rev-list", "--count", before + ".." + after], cwd=root, timeout=20).strip() or 0)


def push(root, token=None, branch=None):
    info = status(root)
    target = branch or info["branch"]
    if not target:
        raise GitError("You are not on a branch. Check out a branch first.")
    run(["push", "--quiet", "-u", "origin", "HEAD:refs/heads/" + target], cwd=root, token=token)
    return target


def connect(folder, url, token=None, branch="main", message="Initial commit from KiCad"):
    """Turn a project folder into a git repository pushing to `url`, or point an existing one at it."""
    root = find_repo_root(folder)
    if root is None:
        root = folder
        try:
            run(["init", "--quiet", "-b", branch], cwd=root)
        except GitError:
            run(["init", "--quiet"], cwd=root)  # git older than 2.28
            run(["symbolic-ref", "HEAD", "refs/heads/" + branch], cwd=root)
    if remote_url(root):
        run(["remote", "set-url", "origin", url], cwd=root)
    else:
        run(["remote", "add", "origin", url], cwd=root)
    ensure_gitignore(root)
    # Adopt the remote's history when the repository on Jumper already has commits.
    try:
        run(["fetch", "--quiet", "origin"], cwd=root, token=token)
    except GitError as e:
        if "credentials" in str(e) or "SSH key" in str(e) or "reach" in str(e):
            raise
    head_exists = run(["rev-parse", "--verify", "--quiet", "HEAD"], cwd=root, check=False, timeout=20).strip()
    remote_branch = run(["rev-parse", "--verify", "--quiet", "origin/" + branch], cwd=root, check=False, timeout=20).strip()
    if not head_exists and remote_branch:
        run(["reset", "--quiet", "origin/" + branch], cwd=root)  # keep the working files, take the remote history
    pending = status(root)["changes"]
    if pending:
        commit_all(root, message)
    push(root, token=token, branch=branch)
    return root


# ---------- settings ----------

def config_path():
    base = os.environ.get("APPDATA") if os.name == "nt" else os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base or os.path.expanduser("~"), "jumper", "kicad-plugin.json")


def load_config():
    try:
        with open(config_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(data):
    path = config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    # The file holds access tokens: readable by this user only.
    try:
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    os.replace(tmp, path)


def token_for(clone_url, config=None):
    """The saved token for the remote's host, used only over HTTPS."""
    if not is_https(clone_url):
        return None
    cfg = config if config is not None else load_config()
    return (cfg.get("tokens") or {}).get(host_of(clone_url) or "")


def save_token(host, token):
    cfg = load_config()
    tokens = cfg.get("tokens") or {}
    if token:
        tokens[host.lower()] = token
    else:
        tokens.pop(host.lower(), None)
    cfg["tokens"] = tokens
    save_config(cfg)


# ---- branches and the Jumper API (check results) ----

def current_branch(root):
    return run(["rev-parse", "--abbrev-ref", "HEAD"], cwd=root, timeout=30).strip()


def head_sha(root):
    return run(["rev-parse", "HEAD"], cwd=root, timeout=30).strip()


def create_branch(root, name):
    """Create a branch from the current commit and switch to it. Uncommitted edits come along."""
    name = (name or "").strip()
    try:
        run(["check-ref-format", "--branch", name], cwd=root, timeout=30)
    except GitError:
        raise GitError("'%s' is not a valid branch name. Use letters, digits, '-', '_' and '/'." % name)
    run(["switch", "-c", name], cwd=root, timeout=60)
    return name


def api_base(clone_url):
    """https://host/api/repos/owner/repo for a clone URL, or None."""
    web = web_url(clone_url)
    if not web:
        return None
    p = urlparse(web)
    parts = [x for x in p.path.split("/") if x]
    if len(parts) < 2:
        return None
    return "%s://%s/api/repos/%s/%s" % (p.scheme, p.netloc, quote(parts[-2]), quote(parts[-1]))


def compare_url(clone_url, branch, base="main"):
    web = web_url(clone_url)
    return "%s/compare?base=%s&head=%s" % (web, quote(base), quote(branch)) if web and branch else None


def checks_summary(clone_url, sha, token=None, timeout=15):
    """Check results for a commit: {'state': 'pending'|'success'|'failure'|'none', 'text': str, 'runs': [...]}."""
    base = api_base(clone_url)
    if not base:
        return {"state": "none", "text": "Checks are shown for Jumper remotes only.", "runs": []}
    req = urllib.request.Request("%s/checks?sha=%s" % (base, quote(sha)), headers={"Accept": "application/json", "User-Agent": "jumper-kicad"})
    if token:
        req.add_header("Authorization", "Bearer %s" % token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 404):
            return {"state": "none", "text": "Add a token (Token...) to see check results.", "runs": []}
        return {"state": "none", "text": "Could not load checks (HTTP %d)." % e.code, "runs": []}
    except Exception:
        return {"state": "none", "text": "Could not reach Jumper to load checks.", "runs": []}
    runs = data.get("runs") or []
    if not runs:
        return {"state": "pending", "text": "Checks have not started for this commit yet.", "runs": []}
    running = [r for r in runs if r.get("status") != "completed"]
    failed = [r for r in runs if r.get("conclusion") == "failure"]
    passed = [r for r in runs if r.get("conclusion") == "success"]
    if running:
        state, text = "pending", "Checks running: %d of %d done." % (len(runs) - len(running), len(runs))
    elif failed:
        state, text = "failure", "%d of %d checks failing: %s." % (len(failed), len(runs), ", ".join(r.get("name", "?") for r in failed))
    else:
        state, text = "success", "All %d checks passed." % len(runs) if len(passed) == len(runs) else "Checks finished: %d passed." % len(passed)
    return {"state": state, "text": text, "runs": runs}

