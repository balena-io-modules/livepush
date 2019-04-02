FROM base AS base
COPY a b
RUN command
FROM base2 AS base2
COPY a b
RUN command1
RUN command2
COPY --from=base c d
RUN command3
RUN command4
CMD cmd

