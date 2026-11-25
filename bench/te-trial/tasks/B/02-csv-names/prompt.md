"Export CSV" on a database writes raw ids in some cells. Person columns and the created-by and edited-by columns give ids like `u_ada` instead of the person's name. Relation columns give page ids like `p_pwwrf4j7kujg` instead of the linked page's title.

What I expect: people appear by their profile name, and linked pages by their title. If an id cannot be resolved, which means the profile or page is gone, the cell keeps the id as before.
