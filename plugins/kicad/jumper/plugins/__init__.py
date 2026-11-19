# KiCad loads this package and registers the action plugin. Importing pcbnew/wx only works inside KiCad, so a plain
# `import jumper_git` (tests, tooling) never reaches this file's registration.
try:
    from .jumper_action import JumperPlugin

    JumperPlugin().register()
except Exception as e:  # pragma: no cover - only inside KiCad
    import logging

    logging.getLogger("jumper").exception("Jumper plugin failed to load: %s", e)
