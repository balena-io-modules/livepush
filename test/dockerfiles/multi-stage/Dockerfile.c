FROM baseimage as base
RUN cmd
COPY a b
RUN cmd2
FROM baseimage2
COPY --from=base b c
CMD cmd3
