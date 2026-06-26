with open('app/page.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

modal_start = content.find('{showSummaryModal && (')
modal_end = content.find('{/* Full-width white header */}')
modal = content[modal_start:modal_end]

replacements = [
    ("maxWidth: '520px'", "maxWidth: '624px'"),
    ("padding: '24px 36px 20px'", "padding: '29px 44px 24px'"),
    ("padding: '0 36px 10px'", "padding: '0 44px 12px'"),
    ("padding: '14px 36px 16px'", "padding: '17px 44px 19px'"),
    ("padding: '14px 36px 10px'", "padding: '17px 44px 12px'"),
    ("padding: '4px 36px 0'", "padding: '5px 44px 0'"),
    ("padding: '16px 36px'", "padding: '19px 44px'"),
    ("padding: '16px 36px 20px'", "padding: '19px 44px 24px'"),
    ("padding: '4px 36px 28px'", "padding: '5px 44px 34px'"),
    ("padding: '12px 36px 20px'", "padding: '14px 44px 24px'"),
    ("left: '-16px', width: '32px', height: '32px'", "left: '-19px', width: '38px', height: '38px'"),
    ("right: '-16px', width: '32px', height: '32px'", "right: '-19px', width: '38px', height: '38px'"),
    ("margin: '0 20px'", "margin: '0 24px'"),
]

for old, new in replacements:
    modal = modal.replace(old, new)

new_content = content[:modal_start] + modal + content[modal_end:]
with open('app/page.tsx', 'w', encoding='utf-8') as f:
    f.write(new_content)
print('Done')
