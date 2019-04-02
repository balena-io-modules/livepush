FROM image
WORKDIR /usr/src/app
COPY a.test b.test
COPY c.test d.test
RUN command
RUN command2
CMD test
