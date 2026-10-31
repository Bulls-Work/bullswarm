Restoring a version of a database sometimes does not bring all the rows back. A second tab that has the database page open but has never opened its rows view restores a version, and rows from that version that the tab has not loaded are skipped without any message. The same gap makes the db-history "too large" test flaky, about one run in six.

What I expect: restoring a version first loads the rows of that version that the workspace does not have yet, then puts their values back. After the restore (and a flush) each row has the values it had in the version, and the result is ok.
