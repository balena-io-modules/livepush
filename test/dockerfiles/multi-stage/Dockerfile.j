FROM base AS base
COPY testfile testfile2 /tmp/
FROM base2
COPY --from=base /tmp/testfile /tmp/testfile
COPY --from=base /tmp/testfile2 /tmp/testfile2
