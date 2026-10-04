import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import collectors

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "sources.sh"


class SourcesPathTests(unittest.TestCase):
    def test_the_service_credential_comes_first(self):
        with tempfile.TemporaryDirectory() as temp:
            env = {"CREDENTIALS_DIRECTORY": temp, "ATMOS_PORTFOLIO_SOURCES": "/elsewhere.json"}
            self.assertEqual(collectors.sources_path(env), "/elsewhere.json")  # no credential called sources
            (Path(temp) / "sources").write_text("{}")
            self.assertEqual(collectors.sources_path(env), str(Path(temp) / "sources"))

    def test_otherwise_the_configured_file(self):
        self.assertEqual(collectors.sources_path({"ATMOS_PORTFOLIO_SOURCES": "/x.json"}), "/x.json")
        self.assertEqual(collectors.sources_path({}), collectors.DEFAULT_CONFIG)


@unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0 and shutil.which("bash") and Path("/run").is_dir(),
                     "sources.sh runs as root on Linux")
class SourcesScriptTests(unittest.TestCase):
    """sources.sh against folders of its own (never /etc), without systemctl."""

    SECRET = "s3cr3t-binance-key"

    def setUp(self):
        self.temp = Path(tempfile.mkdtemp())
        (self.temp / "run").mkdir()
        config = json.loads((HERE / "sources.example.json").read_text())
        config["sources"]["binance-spot"].update(enabled=True, api_key=self.SECRET, api_secret="x")
        self.plain = self.temp / "sources.json"
        self.plain_text = json.dumps(config)
        self.plain.write_text(self.plain_text)
        self.env = {**os.environ,
                    "ATMOS_SOURCES_APP": str(HERE), "ATMOS_SOURCES_CRED_DIR": str(self.temp / "cred"),
                    "ATMOS_SOURCES_PLAIN": str(self.plain), "ATMOS_SOURCES_DROPIN_DIR": str(self.temp / "dropin"),
                    "ATMOS_SOURCES_RUN": str(self.temp / "run"), "ATMOS_SOURCES_NO_SYSTEMCTL": "1"}

    def tearDown(self):
        shutil.rmtree(self.temp)

    def run_script(self, *args, check=True, **env):
        return subprocess.run(["bash", str(SCRIPT), *args], env={**self.env, **env},
                              capture_output=True, text=True, check=check)

    def dropin(self):
        return (self.temp / "dropin" / "sources.conf").read_text()

    @unittest.skipUnless(shutil.which("systemd-creds"), "needs systemd-creds (systemd 250+)")
    def test_setup_encrypts_the_plain_file_and_removes_it(self):
        self.run_script("setup")
        cred = self.temp / "cred" / "sources.cred"
        self.assertFalse(self.plain.exists())
        self.assertEqual(cred.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(self.SECRET.encode(), cred.read_bytes())
        self.assertIn(f"LoadCredentialEncrypted=sources:{cred}", self.dropin())
        self.assertIn(self.SECRET, self.run_script("show").stdout)
        self.run_script("setup")  # again: nothing to do, still readable
        self.assertIn(self.SECRET, self.run_script("show").stdout)
        self.assertEqual(list((self.temp / "run").iterdir()), [])

    @unittest.skipUnless(shutil.which("systemd-creds"), "needs systemd-creds (systemd 250+)")
    def test_edit_and_seal_replace_the_sources_and_refuse_a_broken_file(self):
        self.run_script("setup")
        self.run_script("edit", EDITOR=f"sed -i s/{self.SECRET}/changed-key/")
        self.assertIn("changed-key", self.run_script("show").stdout)
        broken = self.temp / "broken.json"
        broken.write_text("[1, 2]")
        result = self.run_script("seal", str(broken), check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("nothing was changed", result.stderr)
        self.assertIn("changed-key", self.run_script("show").stdout)
        self.assertTrue(broken.exists())  # seal leaves the given file alone
        self.assertEqual(list((self.temp / "run").iterdir()), [])

    @unittest.skipUnless(shutil.which("systemd-creds"), "needs systemd-creds (systemd 250+)")
    def test_seal_and_show_take_paths_relative_to_where_you_are(self):
        self.run_script("setup")
        work = self.temp / "work"
        work.mkdir()
        (work / "mine.json").write_text(self.plain_text.replace(self.SECRET, "relative-key"))
        subprocess.run(["bash", str(SCRIPT), "seal", "mine.json"], env=self.env, cwd=work,
                       capture_output=True, text=True, check=True)
        subprocess.run(["bash", str(SCRIPT), "show", "out.json"], env={**self.env, "SUDO_UID": "65534", "SUDO_GID": "65534"},
                       cwd=work, capture_output=True, text=True, check=True)
        out = work / "out.json"
        self.assertIn("relative-key", out.read_text())
        self.assertEqual((out.stat().st_mode & 0o777, out.stat().st_uid), (0o600, 65534))
        again = subprocess.run(["bash", str(SCRIPT), "show", "out.json"], env=self.env, cwd=work,
                               capture_output=True, text=True)
        self.assertNotEqual(again.returncode, 0)  # never overwrites

    @unittest.skipUnless(shutil.which("systemd-creds"), "needs systemd-creds (systemd 250+)")
    def test_a_collector_that_wont_stay_up_puts_everything_back(self):
        fake = self.temp / "bin"
        fake.mkdir()
        state = self.temp / "active"
        state.write_text("yes")
        # Active until restarted; after a restart it fails (as if it couldn't read the credential).
        (fake / "systemctl").write_text(
            "#!/bin/bash\n"
            f"case \"$1\" in is-active) [[ $(cat {state}) == yes ]] ;; restart|try-restart) echo no > {state} ;; esac\n")
        (fake / "systemctl").chmod(0o755)
        env = {"PATH": f"{fake}:{os.environ['PATH']}", "ATMOS_SOURCES_NO_SYSTEMCTL": "", "ATMOS_SOURCES_SETTLE": "0"}
        result = self.run_script("setup", check=False, **env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("weren't kept", result.stderr)
        self.assertIn(self.SECRET, self.plain.read_text())  # the plain file is still there
        self.assertFalse((self.temp / "cred" / "sources.cred").exists())
        self.assertFalse((self.temp / "dropin" / "sources.conf").exists())

    def test_systemd_247_to_249_keeps_it_plain_but_root_only(self):
        self.plain.chmod(0o644)
        self.run_script("setup", ATMOS_SOURCES_FORCE_PLAIN="1", ATMOS_SOURCES_SYSTEMD_VERSION="249")
        self.assertEqual(self.plain.stat().st_mode & 0o777, 0o600)
        self.assertIn(f"LoadCredential=sources:{self.plain}", self.dropin())

    def test_before_systemd_247_nothing_changes_for_the_collector(self):
        group = Path("/etc/group").read_text().split(":", 1)[0]  # any existing group
        self.run_script("setup", ATMOS_SOURCES_FORCE_PLAIN="1", ATMOS_SOURCES_SYSTEMD_VERSION="245",
                        ATMOS_SOURCES_GROUP=group)
        self.assertEqual(self.plain.stat().st_mode & 0o777, 0o640)
        self.assertFalse((self.temp / "dropin" / "sources.conf").exists())

    def test_setup_removes_the_old_workflows_leftovers(self):
        leftover = self.temp / ".sources.json.new"
        leftover.write_text("{}")
        self.run_script("setup", ATMOS_SOURCES_FORCE_PLAIN="1", ATMOS_SOURCES_SYSTEMD_VERSION="249")
        self.assertFalse(leftover.exists())
        self.assertTrue(self.plain.exists())

    def test_without_systemd_creds_the_file_stays_plain_but_root_only(self):
        self.plain.chmod(0o644)
        self.run_script("setup", ATMOS_SOURCES_FORCE_PLAIN="1", ATMOS_SOURCES_SYSTEMD_VERSION="255")
        self.assertEqual(self.plain.stat().st_mode & 0o777, 0o600)
        self.assertIn(f"LoadCredential=sources:{self.plain}", self.dropin())
        self.assertIn(self.SECRET, self.run_script("show", ATMOS_SOURCES_FORCE_PLAIN="1", ATMOS_SOURCES_SYSTEMD_VERSION="255").stdout)

    def test_the_collector_reads_what_the_dropin_hands_it(self):
        # What systemd does at start: the credential appears in the service's
        # credentials folder, and the collector takes it from there.
        credentials = self.temp / "credentials"
        credentials.mkdir()
        shutil.copy(self.plain, credentials / "sources")
        path = collectors.sources_path({"CREDENTIALS_DIRECTORY": str(credentials)})
        self.assertEqual(collectors.load_config(path)["sources"]["binance-spot"]["api_key"], self.SECRET)


if __name__ == "__main__":
    unittest.main()
