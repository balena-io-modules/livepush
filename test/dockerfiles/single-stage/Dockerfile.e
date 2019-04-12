
FROM baseimage
WORKDIR /usr/src/app
COPY a.ts b.ts
RUN anothercommand
WORKDIR /usr/src/app/src/
COPY c.ts d.ts
RUN multi arg command
RUN command2
