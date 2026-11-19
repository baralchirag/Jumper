"""Jumper action plugin for KiCad's PCB editor: commit, push and pull the open project without leaving KiCad."""

import os
import threading
import webbrowser

import pcbnew
import wx

from . import jumper_git as g

PLUGIN_VERSION = "1.1.0"


def _project_dir():
    board = pcbnew.GetBoard()
    path = board.GetFileName() if board else ""
    return os.path.dirname(path) if path else None


def _board_modified():
    board = pcbnew.GetBoard()
    try:
        return bool(board and board.IsModified())
    except AttributeError:  # older KiCad
        return False


class ConnectDialog(wx.Dialog):
    """Ask for the repository URL (and a token for HTTPS) to connect a project that has no remote yet."""

    def __init__(self, parent, folder):
        super().__init__(parent, title="Connect to Jumper", style=wx.DEFAULT_DIALOG_STYLE | wx.RESIZE_BORDER)
        s = wx.BoxSizer(wx.VERTICAL)
        intro = wx.StaticText(self, label=(
            "Create an empty repository on Jumper, then paste its clone URL here.\n"
            "This folder will be committed and pushed:\n" + folder))
        intro.Wrap(460)
        s.Add(intro, 0, wx.ALL, 12)
        grid = wx.FlexGridSizer(2, 8, 8)
        grid.AddGrowableCol(1)
        grid.Add(wx.StaticText(self, label="Clone URL"), 0, wx.ALIGN_CENTER_VERTICAL)
        self.url = wx.TextCtrl(self, size=(360, -1))
        self.url.SetHint("https://jumper.example.com/you/board.git")
        grid.Add(self.url, 1, wx.EXPAND)
        grid.Add(wx.StaticText(self, label="Access token"), 0, wx.ALIGN_CENTER_VERTICAL)
        self.token = wx.TextCtrl(self, style=wx.TE_PASSWORD)
        self.token.SetHint("Settings > Personal access tokens (repo:write)")
        grid.Add(self.token, 1, wx.EXPAND)
        s.Add(grid, 0, wx.EXPAND | wx.LEFT | wx.RIGHT, 12)
        note = wx.StaticText(self, label="Not needed for SSH URLs. Saved for this server in your user settings, readable only by you.")
        note.SetForegroundColour(wx.Colour(110, 110, 110))
        note.Wrap(460)
        s.Add(note, 0, wx.ALL, 12)
        s.Add(self.CreateStdDialogButtonSizer(wx.OK | wx.CANCEL), 0, wx.EXPAND | wx.ALL, 12)
        self.SetSizerAndFit(s)


class JumperDialog(wx.Dialog):
    def __init__(self, parent, root):
        super().__init__(parent, title="Jumper", size=(620, 560), style=wx.DEFAULT_DIALOG_STYLE | wx.RESIZE_BORDER)
        self.root = root
        self.remote = g.remote_url(root)
        self.token = g.token_for(self.remote)
        panel = self
        s = wx.BoxSizer(wx.VERTICAL)

        self.heading = wx.StaticText(panel, label="")
        f = self.heading.GetFont()
        f.SetWeight(wx.FONTWEIGHT_BOLD)
        self.heading.SetFont(f)
        s.Add(self.heading, 0, wx.ALL, 12)
        self.sub = wx.StaticText(panel, label="")
        s.Add(self.sub, 0, wx.LEFT | wx.RIGHT, 12)

        checks_row = wx.BoxSizer(wx.HORIZONTAL)
        self.checks = wx.StaticText(panel, label="Checks: loading...")
        checks_row.Add(self.checks, 1, wx.ALIGN_CENTER_VERTICAL)
        self.btn_checks = wx.Button(panel, label="View checks")
        self.btn_checks.SetToolTip("Open this commit's ERC, DRC, renders and BOM on Jumper")
        checks_row.Add(self.btn_checks, 0)
        s.Add(checks_row, 0, wx.EXPAND | wx.LEFT | wx.RIGHT | wx.TOP, 12)

        self.changes = wx.ListCtrl(panel, style=wx.LC_REPORT | wx.LC_SINGLE_SEL)
        self.changes.InsertColumn(0, "Change", width=100)
        self.changes.InsertColumn(1, "File", width=460)
        s.Add(self.changes, 1, wx.EXPAND | wx.ALL, 12)

        s.Add(wx.StaticText(panel, label="What did you change?"), 0, wx.LEFT | wx.RIGHT, 12)
        self.message = wx.TextCtrl(panel, style=wx.TE_MULTILINE, size=(-1, 70))
        self.message.SetHint("e.g. Move USB connector to the board edge")
        s.Add(self.message, 0, wx.EXPAND | wx.ALL, 12)

        self.feedback = wx.StaticText(panel, label="")
        s.Add(self.feedback, 0, wx.EXPAND | wx.LEFT | wx.RIGHT, 12)

        row = wx.BoxSizer(wx.HORIZONTAL)
        self.btn_pull = wx.Button(panel, label="Pull")
        self.btn_pull.SetToolTip("Get the latest commits from Jumper")
        self.btn_push = wx.Button(panel, label="Commit and push")
        self.btn_push.SetToolTip("Save every change in a commit and send it to Jumper")
        self.btn_web = wx.Button(panel, label="Open on Jumper")
        self.btn_branch = wx.Button(panel, label="New branch…")
        self.btn_branch.SetToolTip("Work on a change in its own branch, then open a pull request for review")
        self.btn_pr = wx.Button(panel, label="Open pull request")
        self.btn_pr.SetToolTip("Ask your team to review this branch on Jumper, board against board")
        self.btn_token = wx.Button(panel, label="Token…")
        self.btn_close = wx.Button(panel, wx.ID_CANCEL, label="Close")
        for b in (self.btn_pull, self.btn_push, self.btn_branch, self.btn_pr, self.btn_web, self.btn_token):
            row.Add(b, 0, wx.RIGHT, 6)
        row.AddStretchSpacer()
        row.Add(self.btn_close, 0)
        s.Add(row, 0, wx.EXPAND | wx.ALL, 12)
        self.SetSizer(s)

        self.btn_pull.Bind(wx.EVT_BUTTON, self.on_pull)
        self.btn_push.Bind(wx.EVT_BUTTON, self.on_push)
        self.btn_web.Bind(wx.EVT_BUTTON, lambda e: webbrowser.open(g.web_url(self.remote) or ""))
        self.btn_token.Bind(wx.EVT_BUTTON, self.on_token)
        self.btn_branch.Bind(wx.EVT_BUTTON, self.on_branch)
        self.btn_pr.Bind(wx.EVT_BUTTON, self.on_pr)
        self.btn_checks.Bind(wx.EVT_BUTTON, self.on_view_checks)
        self.poll = None
        self.btn_web.Enable(bool(g.web_url(self.remote)))
        self.btn_token.Enable(g.is_https(self.remote))
        self.refresh(fetch=True)

    # ---- helpers ----

    def say(self, text, error=False):
        self.feedback.SetLabel(text)
        self.feedback.SetForegroundColour(wx.Colour(180, 40, 30) if error else wx.Colour(30, 120, 60))
        self.feedback.Wrap(580)
        self.Layout()

    def busy(self, on):
        for b in (self.btn_pull, self.btn_push, self.btn_token, self.btn_branch):
            b.Enable(not on)
        if on:
            wx.BeginBusyCursor()
        elif wx.IsBusy():
            wx.EndBusyCursor()

    def in_background(self, work, done):
        """Run git off the UI thread so KiCad stays responsive during network operations."""
        self.busy(True)

        def target():
            try:
                result, err = work(), None
            except g.GitError as e:
                result, err = None, str(e)
            except Exception as e:  # never take KiCad down with us
                result, err = None, "Unexpected error: %s" % e
            wx.CallAfter(self._finish, done, result, err)

        threading.Thread(target=target, daemon=True).start()

    def _finish(self, done, result, err):
        self.busy(False)
        if err:
            self.say(err, error=True)
        else:
            done(result)

    def refresh(self, fetch=False):
        def work():
            return g.status(self.root, fetch_first=fetch, token=self.token)

        def done(info):
            branch = info["branch"] or "(no branch)"
            self.heading.SetLabel("%s  ·  %s" % (os.path.basename(self.root), branch))
            parts = []
            if info["behind"]:
                parts.append("%d new commit%s on Jumper" % (info["behind"], "" if info["behind"] == 1 else "s"))
            if info["ahead"]:
                parts.append("%d commit%s not pushed yet" % (info["ahead"], "" if info["ahead"] == 1 else "s"))
            if not info["upstream"]:
                parts.append("branch not on Jumper yet")
            parts.append("%d changed file%s" % (len(info["changes"]), "" if len(info["changes"]) == 1 else "s"))
            self.sub.SetLabel(" · ".join(parts))
            self.changes.DeleteAllItems()
            for i, (kind, path) in enumerate(info["changes"]):
                self.changes.InsertItem(i, kind)
                self.changes.SetItem(i, 1, path)
            self.info = info
            self.btn_push.SetLabel("Commit and push" if info["changes"] else "Push")
            on_main = info["branch"] in ("main", "master", None)
            self.btn_pr.Enable(bool(info["upstream"]) and not on_main and bool(g.web_url(self.remote)))
            self.Layout()
            self.load_checks()

        self.in_background(work, done)

    # ---- actions ----

    def on_pull(self, _evt):
        if _board_modified():
            wx.MessageBox("Save the board first (Ctrl+S). Pulling replaces files on disk, and unsaved edits could be lost.",
                          "Jumper", wx.OK | wx.ICON_WARNING, self)
            return

        def done(n):
            if n:
                self.say("Pulled %d commit%s. Close and reopen the board to load them (File > Revert)." % (n, "" if n == 1 else "s"))
            else:
                self.say("Already up to date.")
            self.refresh()

        self.in_background(lambda: g.pull(self.root, token=self.token), done)

    def on_push(self, _evt):
        if _board_modified():
            if wx.MessageBox("The board has unsaved changes, which will not be included. Save first?", "Jumper",
                             wx.YES_NO | wx.ICON_QUESTION, self) == wx.YES:
                try:
                    pcbnew.SaveBoard(pcbnew.GetBoard().GetFileName(), pcbnew.GetBoard())
                except Exception as e:
                    self.say("Could not save the board: %s" % e, error=True)
                    return
        changes = getattr(self, "info", {}).get("changes") or []
        message = self.message.GetValue().strip()
        if changes and not message:
            self.say("Write a short message describing what you changed.", error=True)
            self.message.SetFocus()
            return
        if changes and not g.has_identity(self.root):
            dlg = wx.TextEntryDialog(self, "Your name and email for commits, as 'Name <email>':", "Jumper")
            if dlg.ShowModal() != wx.ID_OK:
                return
            text = dlg.GetValue()
            dlg.Destroy()
            if "<" not in text or ">" not in text:
                self.say("Enter it like: Ada Lovelace <ada@example.com>", error=True)
                return
            name, email = text.split("<", 1)
            g.set_identity(self.root, name.strip(), email.strip(" >"))

        def work():
            if changes:
                g.commit_all(self.root, message)
            return g.push(self.root, token=self.token)

        def done(branch):
            self.message.SetValue("")
            self.say("Pushed to %s. Jumper is running checks on it now; results appear above." % branch)
            self.refresh()

        self.in_background(work, done)

    def load_checks(self, attempts=0):
        """Show check results for the pushed commit; after a push, keep looking until they finish."""
        info = getattr(self, "info", {})
        if not info.get("upstream"):
            self.checks.SetLabel("Checks: push this branch to run ERC, DRC, renders and the BOM.")
            return

        def work():
            return g.checks_summary(self.remote, g.head_sha(self.root), token=self.token)

        def done(summary):
            colours = {"success": wx.Colour(30, 120, 60), "failure": wx.Colour(180, 40, 30)}
            self.checks.SetForegroundColour(colours.get(summary["state"], wx.Colour(110, 110, 110)))
            self.checks.SetLabel("Checks: " + summary["text"])
            self.Layout()
            if summary["state"] == "pending" and attempts < 20 and self:
                self.poll = wx.CallLater(8000, self.load_checks, attempts + 1)

        def target():
            try:
                result = work()
            except Exception as e:
                result = {"state": "none", "text": "could not load (%s)" % e}
            wx.CallAfter(lambda: self and done(result))

        threading.Thread(target=target, daemon=True).start()

    def on_view_checks(self, _evt):
        web = g.web_url(self.remote)
        if web:
            webbrowser.open("%s/checks" % web)

    def on_branch(self, _evt):
        dlg = wx.TextEntryDialog(self, "Name for the new branch (e.g. move-usb-connector). Your unsaved and uncommitted changes come along.", "New branch")
        if dlg.ShowModal() == wx.ID_OK:
            name = dlg.GetValue()

            def done(branch):
                self.say("Switched to %s. Commit and push, then open a pull request." % branch)
                self.refresh()

            self.in_background(lambda: g.create_branch(self.root, name), done)
        dlg.Destroy()

    def on_pr(self, _evt):
        info = getattr(self, "info", {})
        url = g.compare_url(self.remote, info.get("branch"))
        if url:
            webbrowser.open(url)

    def on_token(self, _evt):
        host = g.host_of(self.remote)
        dlg = wx.TextEntryDialog(self, "Personal access token for %s (needs repo:write). Leave empty to remove it." % host,
                                 "Jumper token", style=wx.OK | wx.CANCEL | wx.TE_PASSWORD)
        if dlg.ShowModal() == wx.ID_OK:
            g.save_token(host, dlg.GetValue().strip())
            self.token = g.token_for(self.remote)
            self.say("Token saved." if self.token else "Token removed.")
        dlg.Destroy()


class JumperPlugin(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "Jumper"
        self.category = "Version control"
        self.description = "Jumper: commit, push and pull this project, open pull requests and see check results, without leaving KiCad."
        self.show_toolbar_button = True
        self.icon_file_name = os.path.join(os.path.dirname(__file__), "icon.png")

    def Run(self):
        parent = wx.FindWindowByName("PcbFrame") or None
        folder = _project_dir()
        if not folder:
            wx.MessageBox("Save the board to a file first.", "Jumper", wx.OK | wx.ICON_INFORMATION, parent)
            return
        if not g.git_available():
            wx.MessageBox("Jumper needs git. Install it from https://git-scm.com, then restart KiCad.", "Jumper",
                          wx.OK | wx.ICON_WARNING, parent)
            return
        root = g.find_repo_root(folder)
        if root is None or not g.remote_url(root):
            dlg = ConnectDialog(parent, root or folder)
            if dlg.ShowModal() != wx.ID_OK:
                dlg.Destroy()
                return
            url, token = dlg.url.GetValue().strip(), dlg.token.GetValue().strip()
            dlg.Destroy()
            if not url:
                return
            if token and g.is_https(url):
                g.save_token(g.host_of(url), token)
            with wx.BusyCursor():
                try:
                    root = g.connect(root or folder, url, token=g.token_for(url))
                except g.GitError as e:
                    wx.MessageBox(str(e), "Jumper", wx.OK | wx.ICON_ERROR, parent)
                    return
            wx.MessageBox("Connected and pushed. Your project is on Jumper.", "Jumper", wx.OK | wx.ICON_INFORMATION, parent)
        dlg = JumperDialog(parent, root)
        dlg.ShowModal()
        dlg.Destroy()
