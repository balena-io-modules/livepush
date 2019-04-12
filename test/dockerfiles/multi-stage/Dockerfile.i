FROM base as base
COPY a b
FROM base2 as base2
COPY c d
RUN command
FROM base3 as base3
COPY --from=base b c
FROM base4 as base4
COPY --from=base2 d e
CMD cmd
