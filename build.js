function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

function string_searchAll(string, regex) {
    regex = regex.toString().replace(/\/(.*)\/g/, "$1")
    const positions = []

    let nextRegex = regex
    while (true) {
        result = string.search(new RegExp(nextRegex))
        if (result == -1) {
            break
        }
        nextRegex = ".{" + result + ",}?" + regex
        positions.push(result)
    }
    return positions
}

function fixTomlQuotes(text) {
    return text.replace(/'{4,}/g, (match) => {
        return match.slice(0, match.length - 3) + " '''";
    });
}

async function fixGotoInZip(zipfile) {
    for (const path of Object.keys(zipfile.files)) {
        if (!path.endsWith('.lua')) continue
        const file = zipfile.file(path)
        if (!file) continue
        let contents = await file.async('string')
        if (!contents.includes('goto') && !contents.includes('::')) continue
        contents = contents.replace(/\bthen\s+goto\s+\w+\s+end/g, 'then end')
        contents = contents.replace(/\bgoto\s+\w+/g, '-- goto (removed)')
        contents = contents.replace(/::\w+::/g, '')
        zipfile.file(path, contents)
    }
}

/**
 * 
 * @param {Blob | File} blob .zip or .exe of balatro
 * @param {Object<string, Object>} mods Nested object of mods
 * @returns {Promise<Blob>} .zip of patched source
 */
async function buildFromSource(blob, mods) {
    const progress_bar = $("progressBar")
    const status_text = $("status")

    progress_bar.value = "0"
    status_text.innerText = "Finding Source"

    const buffer = await blob.arrayBuffer()
    const reader = new BufferReader(buffer)

    while (true) {
        if (reader.string(4) === "PK\x03\x04") break
        reader.step(-3)
    }

    progress_bar.value = "30"
    reader.step(-4)
    const pkfile = reader.bytes(reader.view.byteLength - reader.offset)

    function get_file(path) {
        let current = zipfile
        for (const chunk of path.split("/").slice(0, -1)) {
            current = zipfile.folder(chunk)
        }
        const file = current.file(path.split("/").at(-1))
        if (!file) {
            console.warn("Patch target not found, skipping: " + path)
            return Promise.resolve(null)
        }
        return file.async("string")
    }

    function get_mod_file(mod, path) {
        let current = mods[mod]
        const chunks = path.split("/")
        for (const chunk of chunks) {
            current = current[chunk]
        }
        const file = current;
        return file.text()
    }

    function set_file(path, data) {
        let current = zipfile
        for (const chunk of path.split("/").slice(0, -1)) {
            current = current.folder(chunk)
        }
        current.file(path.split("/").at(-1), data)
    }

    progress_bar.value = "40"
    status_text.innerText = "Extracting zip"
    const zipfile = await JSZip.loadAsync(new Blob([pkfile]))

    const patch_list = [];

    function parseLovelyDump(obj, path) {
        for (const [name, value] of Object.entries(obj)) {
            if (!(value instanceof File)) {
                parseLovelyDump(value, path + name + "/");
                continue;
            }
            set_file(path + name, value)
        }
    }

    let smodsPreflight = null

    if (mods["Dump from Lovely"]) {
        const dumpTree = mods["Dump from Lovely"]
        const keys = Object.keys(dumpTree)
        const firstVal = keys.length > 0 ? dumpTree[keys[0]] : null
        const isNested = firstVal && !(firstVal instanceof File) && keys.length === 1
        parseLovelyDump(isNested ? dumpTree[keys[0]] : dumpTree, "")

        // Find the SMODS preflight core.lua
        const preflightPath = Object.keys(zipfile.files).find(p =>
            p.includes('preflight') && p.endsWith('core.lua') && !p.endsWith('.json')
        )
        if (preflightPath) {
            smodsPreflight = preflightPath
            console.log("Found SMODS preflight at:", preflightPath)
        }

        // Copy SMODS src files from SMODS/_/src/ to SMODS/src/
        const smodsUnderscorePrefix = 'SMODS/_/'
        const smodsUnderscorePaths = Object.keys(zipfile.files).filter(p => p.startsWith(smodsUnderscorePrefix))
        if (smodsUnderscorePaths.length > 0) {
            for (const path of smodsUnderscorePaths) {
                const file = zipfile.file(path)
                if (!file || zipfile.files[path].dir) continue
                const contents = await file.async('uint8array')
                zipfile.file(path.replace(smodsUnderscorePrefix, 'SMODS/'), contents)
            }
        }

        // Copy lovely/SMODS/ preflight files to SMODS/ with flattened paths
        const lovelySmods = 'lovely/SMODS/'
        const lovelySmodsPaths = Object.keys(zipfile.files).filter(p => p.startsWith(lovelySmods))
        for (const path of lovelySmodsPaths) {
            const file = zipfile.file(path)
            if (!file || zipfile.files[path].dir) continue
            const contents = await file.async('uint8array')
            const relative = path.replace(lovelySmods, '')
            const lastSrcIdx = relative.lastIndexOf('src/')
            const flatPath = lastSrcIdx !== -1 ? relative.slice(lastSrcIdx + 4) : relative
            zipfile.file('SMODS/' + flatPath, contents)
        }
    }

    for (const [name, mod] of Object.entries(mods)) {
        if (name == "Dump from Lovely") {
            continue
        }

        const tomls = []
        if (mod["lovely.toml"]) {
            tomls.push({
                toml: mod["lovely.toml"],
                path: "lovely.toml"
            })
        }
        if (mod["lovely"]) {
            for (const [name, patch] of Object.entries(mod["lovely"])) {
                if (name.endsWith(".toml")) {
                    tomls.push({
                        toml: patch,
                        path: "lovely/" + name
                    })
                }
            }
        }
        for (const file of tomls) {
            try {
                patch_list.push({
                    src: toml.parse(fixTomlQuotes(await file.toml.text())),
                    name: name,
                    dont_patch: mod["dont_patch.txt"] ? true : false,
                })
            } catch (err) {
                console.error("Failure while parsing mod " + name + " file " + file.path)
                console.error(err)
            }
        }
    }

    patch_list.sort((a, b) => {
        return a.src.manifest.priority > b.src.manifest.priority ? -1 : a.src.manifest.priority == b.src.manifest.priority ? 0 : 1
    })

    let modules_to_load = {}

    for (const patch_data of patch_list) {
        status_text.innerText = "Applying mod " + patch_data.name
        const vars = patch_data.vars || {}

        function do_vars(string) {
            for (const [key, value] of Object.entries(vars)) {
                string = string.replaceAll(`{{lovely:${key}}}`, value)
            }
            return string
        }

        for (const block of patch_data.src.patches) {

            if (block.pattern && !patch_data.dont_patch) {
                const patch = block.pattern
                patch.limit = patch.limit || Infinity

                let contents = await get_file(patch.target)
                if (contents === null) continue

                if (patch.position == "at") {
                    contents = contents.replace(patch.pattern, patch.payload)
                } else if (patch.position == "before") {
                    contents = contents.replace(patch.pattern, patch.payload + " " + patch.pattern)
                } else {
                    contents = contents.replace(patch.pattern, patch.pattern + " " + patch.payload)
                }

                set_file(patch.target, contents)
            }
            if (block.regex && !patch_data.dont_patch) {
                const patch = block.regex
                patch.limit = patch.limit || Infinity
                patch.line_prepend = patch.line_prepend || ""
                patch.payload = patch.line_prepend + patch.payload.replace("\n", "\n" + patch.line_prepend)

                const pattern = new RegExp(patch.pattern, "g")

                let contents = await get_file(patch.target)
                if (contents === null) continue

                let locs = []

                let data;
                while ((data = pattern.exec(contents)) !== null) {
                    locs.push({
                        index: data.index,
                        index_groups: data.slice(1),
                        groups: data.groups ?? {},
                        match: data[0]
                    })
                }

                let delta = 0;
                let i = 0
                for (const match of locs) {
                    if (i > patch.limit) break
                    i++

                    let replacer = patch.payload;
                    let original_size = match.match.length;
                    for (let i = 0; i < match.index_groups.length; i++) {
                        replacer = replacer.replaceAll("$" + (i + 1), match.index_groups[i])
                    }
                    for (const [key, value] of Object.entries(match.groups)) {
                        replacer = replacer.replaceAll("$" + key, value)
                    }

                    if (patch.position == "at") {
                        contents = contents.slice(0, match.index + delta) + replacer + contents.slice(match.index + delta + original_size)
                        delta += replacer.length - original_size
                    } else if (patch.position == "before") {
                        contents = contents.slice(0, match.index + delta) + replacer + contents.slice(match.index + delta)
                        delta += replacer.length
                    } else {
                        contents = contents.slice(0, match.index + delta + original_size) + replacer + contents.slice(match.index + delta + original_size)
                        delta += replacer.length
                    }
                }

                set_file(patch.target, contents)
            }
            if (block.copy && !patch_data.dont_patch) {
                const patch = block.copy
                let contents = await get_file(patch.target)
                if (contents === null) continue

                if (patch.position == "before") {
                    for (const file of patch.sources) {
                        const source_contents = await get_mod_file(patch_data.name, file)
                        contents = "-- " + patch_data.name + " - " + file + "\n" + source_contents + "\n" + contents
                    }
                } else {
                    for (const file of patch.sources) {
                        const source_contents = await get_mod_file(patch_data.name, file)
                        contents += "\n-- " + patch_data.name + " - " + file + "\n" + source_contents
                    }
                }
                set_file(patch.target, contents)
            }
            if (block.module) {
                const patch = block.module
                const file_name = patch.name.replace(".", "/") + ".lua"
                set_file(file_name, await get_mod_file(patch_data.name, patch.source))

                if (!patch_data.dont_patch) {
                    modules_to_load[patch.before] = modules_to_load[patch.before] || []
                    modules_to_load[patch.before].push(patch.name)
                }
            }
        }
    }

    for (const [path, module] of Object.entries(modules_to_load)) {
        let contents = await get_file(path)
        if (contents === null) continue
        for (const to_require of module) {
            contents += `\nrequire '${to_require}'`
        }
        set_file(path, contents)
    }

    function move_dir(dir, path) {
        for (const [name, file] of Object.entries(dir)) {
            if (!(file instanceof File)) {
                zipfile.folder(path + name)
                move_dir(file, path + name + "/")
            } else {
                zipfile.file(path + name, file)
            }
        }
    }

    const mods_without_dump = {}
    for (const [mod_name, mod_data] of Object.entries(mods)) {
        if (mod_name != "Dump from Lovely") {
            mods_without_dump[mod_name] = mod_data
        }
    }
    console.log(mods_without_dump)
    move_dir(mods_without_dump, "Mods/")

    // Find SMODS mod folder and copy ALL src files to SMODS/ so requires resolve
    const smodsFolderEntry = Object.keys(zipfile.files).find(p =>
        p.startsWith('Mods/') && p.toLowerCase().includes('smods') && p.split('/').length === 3 && p.endsWith('/')
    )
    const smodsFolderName = smodsFolderEntry ? smodsFolderEntry.split('/')[1] : null
    if (smodsFolderName) {
        const smodsModSrc = 'Mods/' + smodsFolderName + '/src/'
        const smodsModSrcFiles = Object.keys(zipfile.files).filter(p => p.startsWith(smodsModSrc))
        for (const path of smodsModSrcFiles) {
            const file = zipfile.file(path)
            if (!file || zipfile.files[path].dir) continue
            const contents = await file.async('uint8array')
            const relPath = path.replace(smodsModSrc, '')
            zipfile.file('SMODS/src/' + relPath, contents)
            zipfile.file('SMODS/' + relPath, contents)
        }
        console.log("Copied SMODS src files from Mods/" + smodsFolderName + "/src/")
    }

    // Fix goto/label syntax in ALL lua files — must run AFTER all mod files are
    // in the zip (after move_dir and src copy), so SMODS src files get fixed too
    await fixGotoInZip(zipfile)

    progress_bar.value = "50"
    status_text.innerText = "Applying Patches"

    for (const patch_file of Object.keys(window.patches)) {
        zipfile.file(patch_file, window.patches[patch_file])
    }

    // Override SMODS nativefs AFTER everything else so it always wins
    if (mods["Dump from Lovely"]) {
        zipfile.file("SMODS/nativefs.lua", window.patches["nativefs.lua"])
    }

    // Put web nativefs at root so require('nativefs') always finds it first
    zipfile.file("nativefs.lua", window.patches["nativefs.lua"])

    // Debug: show what's in Mods/
    console.log('Mods/ folders:', Object.keys(zipfile.files).filter(p => p.startsWith('Mods/') && p.split('/').length === 3 && p.endsWith('/')))

    // Fix SMODS manifest.json — the web build needs main_file set correctly
    // to prevent 'duplicate installation' crash
    const smodsManifestEntry = Object.keys(zipfile.files).find(p =>
        p.startsWith('Mods/') && p.toLowerCase().includes('smods') && p.endsWith('/manifest.json')
    )
    if (smodsManifestEntry) {
        const smodsFolderForManifest = smodsManifestEntry.replace('manifest.json', '')
        const fixedManifest = JSON.stringify({
            id: 'Steamodded',
            name: 'Steamodded',
            version: '1.0.0-BETA-1503a',
            main_file: 'main.lua',
            author: ['Steamodded'],
            description: 'SMODS mod loader',
            prefix: 'SMODS'
        })
        zipfile.file(smodsManifestEntry, fixedManifest)
        console.log('Fixed SMODS manifest.json at', smodsManifestEntry)
    }

    // Replace nativefs.lua in ALL mod folders with web-compatible version
    // Talisman and other mods ship their own FFI-based nativefs that won't work in web
    for (const path of Object.keys(zipfile.files)) {
        if (path.startsWith('Mods/') && path.endsWith('/nativefs.lua')) {
            console.log('Replacing nativefs in:', path)
            zipfile.file(path, window.patches['nativefs.lua'])
        }
    }

    if (!zipfile.file("web_patched") || mods["Dump from Lovely"]) {
        progress_bar.value = "60"

        {
            const main = zipfile.file("main.lua")
            let contents = await main.async("string")

            let preflightBootstrap = ''
            if (smodsPreflight) {
                const requirePath = smodsPreflight.replace(/\.lua$/, '')
                preflightBootstrap = `-- Bootstrap SMODS preflight (web build)\nrequire "${requirePath}"\n`
            }

            contents = preflightBootstrap + 'require "web_patches"\n' + contents

            // After preflight runs, nativefs.workingDirectory gets set to absolute paths.
            // Reset it and fix SMODS.path to be relative before SMODS loads its src files.
            contents = contents.replace(
                'assert(SMODS.path,',
                () => `-- Fix SMODS.path and nativefs state after preflight navigation
NFS.workingDirectory = ""
if SMODS and SMODS.path then
    SMODS.path = SMODS.path:match("(Mods/[^/]+/)") or SMODS.path
end
assert(SMODS.path,`
            )

            contents = contents.replace(
                /if os == 'OS X' or os == 'Windows' then\s/,
                () => "if false then "
            )
            contents = contents.replace(
                "G:start_up()",
                () => "G.SOUND_MANAGER = { channel = { push = function() end } }\n    G:start_up()"
            )
            zipfile.file("main.lua", contents)
        }

        progress_bar.value = "70"

        {
            const contents = await zipfile.file("globals.lua").async("string")
            zipfile.file("globals.lua", contents.replace("F_SOUND_THREAD = true", "F_SOUND_THREAD = false"))
        }

        progress_bar.value = "80"

        {
            const contents = await zipfile.folder("resources").folder("shaders").file("hologram.fs").async("string")
            zipfile.folder("resources").folder("shaders").file("hologram.fs", contents.replace(/glow_samples;/g, "4;"))
        }

        {
            // Patch game.lua shader loading — wrap newShader in pcall + logging
            const gameFile = zipfile.file('game.lua')
            if (gameFile) {
                let gameContents = await gameFile.async('string')
                gameContents = gameContents.replace(
                    'self.SHADERS[shader_name] = love.graphics.newShader(shader)',
                    'print("Compiling shader: " .. tostring(shader_name))\nlocal _ok, _s = pcall(love.graphics.newShader, shader)\nif _ok then self.SHADERS[shader_name] = _s print("Done: " .. tostring(shader_name)) else print("SHADER FAILED: " .. tostring(shader_name)) end'
                )
                zipfile.file('game.lua', gameContents)
            }
        }

        {
            // Disable fullscreen in conf.lua — browsers block automatic fullscreen
            const confFile = zipfile.file("conf.lua")
            if (confFile) {
                let confContents = await confFile.async("string")
                confContents = confContents.replace("t.window.fullscreen = true", "t.window.fullscreen = false")
                // Also append a forced override at the end just in case
                confContents += "\nt.window.fullscreen = false"
                zipfile.file("conf.lua", confContents)
            }
        }

        zipfile.file("web_patched", "true")
    }

    progress_bar.value = "90"
    status_text.innerText = "Zipping zip"
    const game = await zipfile.generateAsync({ type: "blob" })
    progress_bar.value = "100"
    status_text.innerText = "Done"

    return game
}
