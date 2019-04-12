FROM base AS base
COPY trigger here
RUN command

FROM base2 AS base2
COPY a b
RUN command
COPY --from=base c d
RUN command2

FROM base3 AS base3
RUN command
COPY --from=base2 e f
RUN command2

FROM base4 AS base4
COPY --from=base3 f g
CMD cmd
