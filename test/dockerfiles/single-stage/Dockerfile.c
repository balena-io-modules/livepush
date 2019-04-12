FROM baseimage
RUN somecommand
COPY a.ts b.ts
RUN anothercommand
RUN multi arg command
COPY c.ts d.ts
RUN second anothercommand
