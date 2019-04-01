FROM a
RUN command
FROM b
COPY --from=0 test test2
RUN command2
FROM c
WORKDIR /usr/src/app
COPY --from=1 test2 test3
COPY --from=2 test3 test4
RUN command3
