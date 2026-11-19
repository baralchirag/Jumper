"""Tests for the plugin's git logic, against real git repositories (no KiCad needed): python3 -m unittest discover -s tests"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "jumper", "plugins"))
import jumper_git as g  # noqa: E402

ENV = {"GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@example.com",
       "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="jumper-plugin-")
        self._env = {k: os.environ.get(k) for k in ENV}
        os.environ.update(ENV)
        os.environ["XDG_CONFIG_HOME"] = os.path.join(self.tmp, "config")
        self.remote = os.path.join(self.tmp, "remote.git")
        subprocess.run(["git", "init", "--bare", "-q", "-b", "main", self.remote], check=True)

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def project(self, name):
        d = os.path.join(self.tmp, name)
        os.makedirs(d)
        with open(os.path.join(d, "board.kicad_pcb"), "w") as f:
            f.write("(kicad_pcb)\n")
        with open(os.path.join(d, "board.kicad_prl"), "w") as f:
            f.write("{}\n")
        os.makedirs(os.path.join(d, "board-backups"))
        with open(os.path.join(d, "board-backups", "x.zip"), "w") as f:
            f.write("zip")
        return d


class Branches(Base):
    def test_create_branch_switches_and_rejects_bad_names(self):
        d = self.project("b")
        g.connect(d, self.remote)
        self.assertEqual(g.create_branch(d, "move-usb"), "move-usb")
        self.assertEqual(g.current_branch(d), "move-usb")
        with self.assertRaises(g.GitError):
            g.create_branch(d, "bad name..")
        self.assertEqual(len(g.head_sha(d)), 40)


class Urls(unittest.TestCase):
    def test_api_and_compare_urls(self):
        self.assertEqual(g.api_base("https://jumper.example.com/acme/board.git"), "https://jumper.example.com/api/repos/acme/board")
        self.assertEqual(g.api_base("git@jumper.example.com:acme/board.git"), "https://jumper.example.com/api/repos/acme/board")
        self.assertEqual(g.compare_url("https://j.example/acme/board.git", "feat/x"), "https://j.example/acme/board/compare?base=main&head=feat/x")
        self.assertIsNone(g.api_base(None))
        self.assertEqual(g.checks_summary(None, "abc")["state"], "none")


class Helpers(unittest.TestCase):
    def test_web_url(self):
        self.assertEqual(g.web_url("https://jumper.dev/alice/board.git"), "https://jumper.dev/alice/board")
        self.assertEqual(g.web_url("http://localhost:5173/alice/board.git"), "http://localhost:5173/alice/board")
        self.assertEqual(g.web_url("ssh://git@jumper.dev:2222/alice/board.git"), "https://jumper.dev/alice/board")
        self.assertEqual(g.web_url("git@jumper.dev:alice/board.git"), "https://jumper.dev/alice/board")
        self.assertIsNone(g.web_url(None))

    def test_parse_status(self):
        out = "\n".join([
            "# branch.oid abc", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 a b board.kicad_pcb",
            "1 A. N... 000000 100644 100644 a b new.kicad_sch",
            "2 R. N... 100644 100644 100644 a b R100 renamed.kicad_sym\told.kicad_sym",
            "? notes with space.txt",
        ])
        s = g.parse_status(out)
        self.assertEqual((s["branch"], s["upstream"], s["ahead"], s["behind"]), ("main", "origin/main", 2, 1))
        self.assertEqual(s["changes"], [("modified", "board.kicad_pcb"), ("new", "new.kicad_sch"), ("renamed", "renamed.kicad_sym"), ("new", "notes with space.txt")])

    def test_token_only_for_https_and_matching_host(self):
        cfg = {"tokens": {"jumper.dev": "tok"}}
        self.assertEqual(g.token_for("https://jumper.dev/a/b.git", cfg), "tok")
        self.assertIsNone(g.token_for("https://evil.example/a/b.git", cfg))
        self.assertIsNone(g.token_for("ssh://git@jumper.dev:2222/a/b.git", cfg))

    def test_friendly_errors(self):
        self.assertIn("pushed changes first", g._friendly(" ! [rejected] main -> main (fetch first)"))
        self.assertIn("credentials", g._friendly("fatal: Authentication failed for 'https://x'"))
        self.assertIn("protected", g._friendly("remote: error: main is a protected branch"))


class Flow(Base):
    def test_connect_push_pull_and_divergence(self):
        a = self.project("a")
        root = g.connect(a, self.remote)
        self.assertEqual(os.path.realpath(root), os.path.realpath(a))
        files = subprocess.run(["git", "ls-tree", "-r", "--name-only", "main"], cwd=self.remote, capture_output=True, text=True).stdout.split()
        self.assertIn("board.kicad_pcb", files)
        self.assertIn(".gitignore", files)
        self.assertNotIn("board.kicad_prl", files)
        self.assertFalse(any(f.startswith("board-backups") for f in files))

        # A teammate clones and pushes; we pull it.
        b = os.path.join(self.tmp, "b")
        subprocess.run(["git", "clone", "-q", self.remote, b], check=True)
        with open(os.path.join(b, "board.kicad_pcb"), "a") as f:
            f.write("(net 1)\n")
        g.commit_all(b, "add net")
        g.push(b)
        self.assertEqual(g.status(a, fetch_first=True)["behind"], 1)
        self.assertEqual(g.pull(a), 1)
        self.assertIn("(net 1)", open(os.path.join(a, "board.kicad_pcb")).read())
        self.assertEqual(g.pull(a), 0)

        # Both change: push is refused, pull refuses to merge silently.
        with open(os.path.join(b, "board.kicad_pcb"), "a") as f:
            f.write("(net 2)\n")
        g.commit_all(b, "b change")
        g.push(b)
        with open(os.path.join(a, "board.kicad_pcb"), "a") as f:
            f.write("(net 3)\n")
        g.commit_all(a, "a change")
        with self.assertRaises(g.GitError) as e:
            g.push(a)
        self.assertIn("pushed changes first", str(e.exception))
        with self.assertRaises(g.GitError) as e:
            g.pull(a)
        self.assertIn("both have new commits", str(e.exception))

    def test_connect_adopts_existing_remote_history(self):
        seed = self.project("seed")
        g.connect(seed, self.remote, message="seed")
        fresh = self.project("fresh")
        with open(os.path.join(fresh, "README.md"), "w") as f:
            f.write("# board\n")
        g.connect(fresh, self.remote, message="from fresh")
        log = subprocess.run(["git", "log", "--format=%s", "main"], cwd=self.remote, capture_output=True, text=True).stdout.split()
        # Built on top of the existing history, not a second root commit that would be rejected.
        self.assertEqual(log, ["from", "fresh", "seed"])

    def test_empty_message_is_refused(self):
        a = self.project("a")
        g.connect(a, self.remote)
        with open(os.path.join(a, "x.txt"), "w") as f:
            f.write("x")
        with self.assertRaises(g.GitError):
            g.commit_all(a, "   ")

    def test_gitignore_is_appended_once(self):
        a = self.project("a")
        with open(os.path.join(a, ".gitignore"), "w") as f:
            f.write("my-stuff/\n")
        self.assertTrue(g.ensure_gitignore(a))
        self.assertFalse(g.ensure_gitignore(a))
        text = open(os.path.join(a, ".gitignore")).read()
        self.assertTrue(text.startswith("my-stuff/\n"))
        self.assertEqual(text.count("*-backups/"), 1)

    def test_tokens_saved_privately(self):
        g.save_token("Jumper.dev", "secret")
        self.assertEqual(g.token_for("https://jumper.dev/a/b.git"), "secret")
        if os.name != "nt":
            self.assertEqual(os.stat(g.config_path()).st_mode & 0o777, 0o600)
        g.save_token("jumper.dev", "")
        self.assertIsNone(g.token_for("https://jumper.dev/a/b.git"))


if __name__ == "__main__":
    unittest.main()
