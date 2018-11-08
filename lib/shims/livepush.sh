#!/bin/sh.real

cp /bin/sh.real /bin/sh
/bin/sh -c "$@"
echo "Application container stopped."
while true; do sleep 10; done;
