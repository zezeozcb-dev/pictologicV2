const ui = global.ui;
const fast = require("pictologic/fast");

/**
 * Calculates the optimal number of rows (Ny) and columns (Nx) for a given number N,
 * aiming for the most square grid possible.
 * @param {number} N - Total number of displays.
 * @returns {{Nx: number, Ny: number}} Object with the number of columns (Nx) and rows (Ny).
 */
function calculateGrid(N) {
    if (N <= 0) return { Nx: 1, Ny: 1 };
    
    let Nx = Math.round(Math.sqrt(N));
    if (Nx === 0) Nx = 1; 
    
    let Ny = Math.ceil(N / Nx);
    
    return { Nx: Nx, Ny: Ny };
}

const core = {
    // settings //
    display: Blocks.logicDisplay,
    size: Blocks.logicDisplay.displaySize,
    speed: LExecutor.maxInstructions,
    quality: 255,
    hsv: false,
    useGray: false,
    
    displayCount: 1, 

    stage: "",
    settings: null,
    image: null
};

const stile = (tile, config) => new Schematic.Stile(tile.block(),
    tile.x, tile.y, config, 0);

core.build = () => {
    const d = new BaseDialog("$settings");
    core.settings = d;

    const displays = Vars.content.blocks().select(block => block instanceof LogicDisplay);
    d.cont.pane(t => {
        t.defaults().growX().center();

        const icon = new TextureRegionDrawable(core.display.uiIcon);
        t.button("Display", icon, () => {
            ui.select("Select Display", displays, d => {
                core.display = d;
                core.size = d.displaySize;
                icon.region = d.uiIcon;
            }, i => displays.get(i).localizedName);
        }).height(120).row();

        const speed = new Table();
        speed.add("Speed: ").right();
        speed.field(core.speed, str => {
            core.speed = parseInt(str);
        }).growX().left().get().validator = str => !isNaN(parseInt(str));
        t.add(speed).height(64).row();

        // Display Count (N) input
        const displayCountTable = new Table();
        displayCountTable.add("Display Count (N): ").right();
        displayCountTable.field("" + core.displayCount, str => {
            const n = parseInt(str);
            if (!isNaN(n) && n > 0) {
                core.displayCount = n;
            } else {
                core.displayCount = 1;
            }
        }).growX().left().get().validator = str => {
            const n = parseInt(str);
            return !isNaN(n) && n > 0;
        };
        t.add(displayCountTable).height(64).row(); 

        // If false, transparency is simple channel multiplication vs blending over display colour
        t.check("Gray Transparency", core.useGray, b => {core.useGray = b})
            .growX().center().row();

        const quality = new Table();
        quality.add("Quality:").center().row();
        quality.defaults().growX().center();

        var slider;
        const field = quality.field("" + core.quality, t => {
            const n = parseInt(t);
            core.quality = "" + n;
            slider.value = n;
        }).get();
        field.validator = t => !isNaN(parseInt(t));

        quality.row();
        slider = quality.slider(0, 255, 1, core.quality, n => {
            core.quality = n;
            field.text = "" + n;
        }).get();

        quality.row();
        quality.check("Use HSV", core.hsv, b => {core.hsv = b})
            .disabled(() => core.quality == 255);
        t.add(quality).height(160);
    }).growY().width(400);

    d.addCloseButton();
};

core.export = pixmap => {
    // 1. Calculate the required grid and total pixel size
    const { Nx, Ny } = calculateGrid(core.displayCount);
    const dispSize = core.size; 
    const totalW = Nx * dispSize;
    const totalH = Ny * dispSize;
    
    // Array to store code blocks for all processors
    const allCodes = [];

    // Scale the source pixmap to fit the total grid size
    if (pixmap.width != totalW || pixmap.height != totalH) {
        core.stage = `Scaling to grid size ${totalW}x${totalH} (${Nx}x${Ny} displays)...`;
        // Scaling with linear filtering
        pixmap = Pixmaps.scale(pixmap, totalW / pixmap.width, totalH / pixmap.height);
    }
    
    // 2. Loop through the grid, crop the image, and generate logic code for each tile
    for (let j = 0; j < Ny; j++) { // Row (Y)
        for (let i = 0; i < Nx; i++) { // Column (X)
            const tileIndex = j * Nx + i;
            
            // Stop processing if we have reached the user-specified display count
            if (tileIndex >= core.displayCount) continue; 
            
            core.stage = `Processing tile ${tileIndex + 1} of ${core.displayCount} (${i + 1}, ${j + 1})...`;

            // a. Crop the pixmap for this tile
            const tilePixmap = new Pixmap(dispSize, dispSize);
            // Copy from source pixmap (x, y, width, height) to tilePixmap (0, 0, width, height)
            tilePixmap.draw(pixmap, 
                i * dispSize, j * dispSize, // Source starting coordinates
                dispSize, dispSize,         // Source width/height
                0, 0,                       // Target starting coordinates
                dispSize, dispSize          // Target width/height
            );

            // b. Optimize and generate logic code for this tile
            // fast.js uses core.size, so we need to ensure it's set to the single display size
            const originalSize = core.size;
            core.size = dispSize; 
            
            // fast(core, tilePixmap) groups the rectangles and handles alpha blending
            const out = fast(core, tilePixmap); 
            
            core.size = originalSize; // Restore original size
            
            // c. Build the code lines for this tile
            const code = [];
            let current = [];
            let drawCalls = 0;
            let curColour = null;
            
            // Link name for this specific display/processor pair
            const flushTarget = `display${tileIndex + 1}`; 

            const check = () => {
                let ret = true;
                // Check if current block of commands exceeds speed limit
                if ((current.length + 2) >= core.speed) {
                    current.push(`drawflush ${flushTarget}`);
                    code.push(current.join("\n"));
                    current = [curColour];
                    drawCalls = 1;
                    ret = false;
                }
                
                // Check if draw calls exceed buffer limit 
                if (++drawCalls >= LExecutor.maxGraphicsBuffer) {
                    current.push(`drawflush ${flushTarget}`);
                    current.push(curColour);
                    drawCalls = 1;
                    ret = false;
                }
                return ret;
            };

            for (var colour in out) {
                curColour = colour;
                if (check()) current.push(colour);
                for (var rect of out[colour]) {
                    check();
                    // 0, 0 is the top left of a PNG and bottom left of a display, flip y
                    current.push("draw rect " + [rect.x, dispSize - rect.y - rect.h, rect.w, rect.h].join(" "));
                }
            }
            
            if (current.length > 0) {
                current.push(`drawflush ${flushTarget}`);
                code.push(current.join("\n"));
            }
            
            allCodes.push(code);
        }
    }

    // 3. Building schematic with a grid of processors and displays
    core.stage = "Building schematic...";
    const tiles = new Seq();
    const processorBlock = Blocks.microProcessor;
    
    // We create a clean layout: Processors (1x1 blocks) on the left, Displays on the right.
    // The separation is 1 tile block.
    // Total Schematic Width = (Nx processors) + (1 tile gap) + (Nx * dispSize display tiles)
    const displayGridStartX = Nx + 1; // Start X for the display grid
    
    let maxWidth = 0;
    let maxHeight = 0;

    for (let j = 0; j < Ny; j++) { // Row (Y)
        for (let i = 0; i < Nx; i++) { // Column (X)
            const tileIndex = j * Nx + i;
            
            if (tileIndex >= core.displayCount) continue; 
            
            // a. Processor position (P_x, P_y) - grid starts at (0, 0)
            const P_x = i;
            const P_y = j;
            
            // b. Display position (D_x, D_y) - grid shifted right
            const D_x = displayGridStartX + i * dispSize; 
            const D_y = j * dispSize; 
            
            // 1. Create Display Tile
            const dispTile = new Tile(D_x, D_y, Blocks.stone, Blocks.air, core.display);
            tiles.add(stile(dispTile, null));

            // 2. Create Processor Tile
            const procBuild = processorBlock.newBuilding();
            procBuild.tile = new Tile(P_x, P_y, Blocks.stone, Blocks.air, processorBlock);
            
            // Link the display to the processor (Name: "displayX")
            const linkName = `display${tileIndex + 1}`;
            procBuild.links.add(new LogicBlock.LogicLink(dispTile.x, dispTile.y, linkName, true));
            
            // Add the code (allCodes[tileIndex] is the array of code blocks for this tile)
            procBuild.updateCode(allCodes[tileIndex].join("\n"));
            
            tiles.add(stile(procBuild.tile, procBuild.config()));
            
            // Update schematic bounds
            maxWidth = Math.max(maxWidth, D_x + dispSize);
            maxHeight = Math.max(maxHeight, D_y + dispSize);
        }
    }

    core.stage = "Saving...";
    // Create and import schematic
    const tags = new StringMap();
    tags.put("name", `!!name me (${Nx}x${Ny} display grid)`);
    const schem = new Schematic(tiles, tags, maxWidth, maxHeight);
    
    Vars.schematics.add(schem);
    Vars.ui.schematics.hide();
    Vars.control.input.useSchematic(schem);

    core.stage = "";
};

module.exports = core;
