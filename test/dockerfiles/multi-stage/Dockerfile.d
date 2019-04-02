FROM baseimage AS base
RUN cmd
COPY a b
RUN cmd2
FROM baseimage2
COPY --from=0 b c
CMD cmd3
