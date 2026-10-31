A page's Activity list quotes titles with their stray spaces. A page titled " renamedWelcome " is logged as `Moved " renamedWelcome "`, and a page whose title is only spaces is logged as `Created page "   "`.

What I expect: the quoted title is trimmed, so `Moved "renamedWelcome"` and `Created page "renamedWelcome"`. A title that is empty or only spaces is shown as Untitled, as in `Moved to trash "Untitled"`.
