FROM base
RUN cmd
FROM base2
COPY --from=0 a b
COPY --from=0 c d
RUN command
CMD cmd
