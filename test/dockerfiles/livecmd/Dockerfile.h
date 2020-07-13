FROM build AS build

#dev-env=UDEV=1 ANOTHER=true
#dev-cmd-live=live

COPY testfile ./
RUN build

FROM run as target

ENV UDEV=1 ANOTHER=true

COPY --from=build /build/smth /tmp/smth
CMD run
