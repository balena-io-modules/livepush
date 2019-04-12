FROM baseimage
COPY src ./
RUN command1
COPY ./ src/
RUN ["array", "based", "command"]
