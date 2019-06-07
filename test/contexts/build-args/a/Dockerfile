FROM alpine:3.1

WORKDIR /usr/src/app

ARG TEST
ARG TEST2
ARG TEST3

COPY file .

RUN echo $TEST2

CMD while true; do echo $TEST; sleep 10; done
