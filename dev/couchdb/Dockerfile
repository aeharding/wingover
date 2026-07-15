# local.ini is baked, not bind-mounted.
#
# The official entrypoint runs `set -e` then chowns everything under
# /opt/couchdb it doesn't already own. A read-only bind mount makes that chown
# fail, and `-f` swallows the message: CouchDB exits 1 with an empty log and no
# clue why. Mounting read-write "works" but leaves docker chowning the host
# file to uid 5984. Baking sidesteps both.
FROM couchdb:3.5
COPY local.ini /opt/couchdb/etc/local.d/10-wingover.ini
