import importlib.util
spec = importlib.util.spec_from_file_location('cardhedge', 'compiq-functions/shared/cardhedge.py')
ch = importlib.util.module_from_spec(spec); spec.loader.exec_module(ch)

queries = [
    "Caleb Bonemer Bowman Chrome Prospect Auto Blue Refractor",
    "Caleb Bonemer CPA-CBO Blue",
    "Caleb Bonemer 2024 Bowman Chrome Autograph Blue",
    "Caleb Bonemer Chrome Prospect Autographs Blue",
]
seen = {}
for q in queries:
    hits = ch.search_cards(q, limit=30)
    for h in hits:
        if str(h.get("number","")).startswith("CPA"):
            seen[h["card_id"]] = h

print(f"unique CPA-* auto cards: {len(seen)}")
for h in seen.values():
    num = h.get("number") or "-"
    var = h.get("variant") or "-"
    print(f"  num={num:<10} variant={var:<40} 7d={h.get('7 Day Sales')} 30d={h.get('30 Day Sales')}  id={h.get('card_id')}")
