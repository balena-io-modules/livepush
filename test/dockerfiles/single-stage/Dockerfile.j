FROM baseimage
RUN command1
COPY src/* src/
RUN command2
RUN command3
COPY test/ test/
RUN command4
