 function updateSpecificSheetAndCSV() {
  // --- CONFIGURATION ---
  const TARGET_SHEET_ID = '10LsVF6_o9wk56Zxf889H2uFCLO_hi51sKK9-w06jHkw';
  const TARGET_CSV_ID = '1PrLEoVooon_-rOZRGzH1BuZbNWLaHDqV';
  const PARENT_FOLDER_ID = '1fLRFjSBTRVYIaud_5DhdQWispEVAae5G'; 
  // ---------------------

  console.time("Total Execution Time");

  try {
    const ss = SpreadsheetApp.openById(TARGET_SHEET_ID);
    const sheet = ss.getSheets()[0];
    sheet.clear();

    let rows = [['Gallery', 'File Name', 'Standard Link', 'Direct Download Link', 'File ID']];
    
    // 1. Fetch Dynamic Galleries
    console.log("Fetching gallery folders...");
    let galleries = [];
    
    const parentFolder = DriveApp.getFolderById(PARENT_FOLDER_ID);
    const subfolders = parentFolder.getFolders();
    
    while (subfolders.hasNext()) {
      let folder = subfolders.next();
      galleries.push({
        name: folder.getName(),
        id: folder.getId()
      });
    }

    galleries.sort((a, b) => a.name.localeCompare(b.name));
    console.log(`Found ${galleries.length} galleries: ${galleries.map(g => g.name).join(', ')}`);
    
    // 2. Process Each Gallery
    galleries.forEach(gallery => {
      const galleryName = gallery.name;
      const folderId = gallery.id;
      
      let pageToken = null;
      let folderFiles = [];

      do {
        // --- V2 COMPATIBILITY FIXES ---
        // 'files' became 'items'
        // 'name' became 'title'
        // 'webViewLink' became 'alternateLink'
        const result = Drive.Files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: 'nextPageToken, items(id, title, alternateLink)', 
          pageToken: pageToken,
          maxResults: 1000 // 'pageSize' is 'maxResults' in v2
        });

        if (result.items && result.items.length > 0) {
          result.items.forEach(file => {
            folderFiles.push([
              galleryName, 
              file.title, // v2 uses title
              file.alternateLink, // v2 uses alternateLink
              `https://drive.google.com/uc?export=download&id=${file.id}`, 
              file.id
            ]);
          });
        }
        pageToken = result.nextPageToken;
      } while (pageToken);

      // Sort files internally by name
      folderFiles.sort((a, b) => a[1].localeCompare(b[1]));
      rows.push(...folderFiles);
    });

    // 3. Write to Sheet
    console.log(`Writing ${rows.length - 1} data rows to Spreadsheet...`);
    if (rows.length > 1) { 
      sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
      sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    }

    // 4. Update CSV
    console.log("Generating CSV...");
    const csvContent = rows.map(row => 
      row.map(cell => `"${cell.toString().replace(/"/g, '""')}"`).join(",")
    ).join("\r\n");

    DriveApp.getFileById(TARGET_CSV_ID).setContent(csvContent);
    console.timeEnd("Total Execution Time");

  } catch (err) {
    console.error("Error: " + err.message);
  }
}