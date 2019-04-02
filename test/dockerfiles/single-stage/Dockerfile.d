FROM baseimage
RUN somecommand
COPY --chown=root:root a.ts b.ts
RUN anothercommand
RUN multi arg command
