# Minimal image used when WORKER_SANDBOX=docker: one throwaway container per
# kicad-cli invocation (no network, read-only root, dropped capabilities).
ARG KICAD_VERSION=9.0
FROM kicad/kicad:${KICAD_VERSION}
USER kicad
ENV HOME=/home/kicad QT_QPA_PLATFORM=offscreen
WORKDIR /work
